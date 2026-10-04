// Builds the film's audio stems in video/audio/.
//
//   node audio.mjs            ElevenLabs: narration + dialogue (TTS), music (Music API), sound effects (text to sound).
//                             Needs ELEVENLABS_API_KEY (env or app/.env) and network access to api.elevenlabs.io.
//                             Existing files are kept; pass --force to regenerate (it costs credits).
//   node audio.mjs --local    Offline fallback: synthesised score and sound effects, no voices.
//
// Then run `node mix.mjs` to mix the stems and mux them onto out/silent.mp4.

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DURATION, SCENES, LINES, SFX, MUSIC, VOICES } from './cues.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DIR = path.join(HERE, 'audio')
const has = (k) => process.argv.includes(`--${k}`)
fs.mkdirSync(path.join(DIR, 'voice'), { recursive: true })
fs.mkdirSync(path.join(DIR, 'sfx'), { recursive: true })

if (has('local')) {
  await synthLocal()
} else {
  await fromElevenLabs()
}

// ------------------------------------------------------------------ ElevenLabs
function readKey() {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY
  const env = path.join(HERE, '..', 'app', '.env')
  if (fs.existsSync(env)) {
    const m = fs.readFileSync(env, 'utf8').match(/^ELEVENLABS_API_KEY=(.+)$/m)
    if (m) return m[1].trim()
  }
  throw new Error('Set ELEVENLABS_API_KEY (or add it to app/.env).')
}

async function fromElevenLabs() {
  const key = readKey()
  const API = 'https://api.elevenlabs.io/v1'
  const force = has('force')
  async function post(url, body, out) {
    if (!force && fs.existsSync(out)) { console.log('keep', path.relative(HERE, out)); return }
    const res = await fetch(`${API}${url}`, { method: 'POST', headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/mpeg' }, body: JSON.stringify(body) })
    if (!res.ok) throw new Error(`${url} -> ${res.status} ${await res.text()}`)
    fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()))
    console.log('wrote', path.relative(HERE, out))
  }

  // Voices: narrator, the ghost (the website's voice) and Sabine.
  const voiceId = (v) => process.env[`${v.toUpperCase()}_VOICE_ID`] || VOICES[v].id
  for (const l of LINES) {
    const v = VOICES[l.voice]
    await post(`/text-to-speech/${voiceId(l.voice)}?output_format=mp3_44100_192`, {
      text: l.text,
      model_id: process.env.ELEVENLABS_TTS_MODEL || 'eleven_multilingual_v2',
      voice_settings: { stability: v.stability, similarity_boost: v.similarity, style: v.style, use_speaker_boost: true },
    }, path.join(DIR, 'voice', `${l.id}.mp3`))
  }

  // Sound effects.
  for (const s of SFX.filter((s) => !s.ref)) {
    await post('/sound-generation?output_format=mp3_44100_192', {
      text: s.prompt, duration_seconds: s.dur, prompt_influence: 0.6, model_id: process.env.ELEVENLABS_SFX_MODEL || 'eleven_text_to_sound_v2',
    }, path.join(DIR, 'sfx', `${s.id}.mp3`))
  }

  // Music: one composition-plan section per scene, so the score turns where the picture does.
  const out = path.join(DIR, 'music.mp3')
  const sections = MUSIC.sections.map((s) => {
    const [a, b] = SCENES[s.scene]
    return { section_name: s.name, positive_local_styles: s.styles, negative_local_styles: [], duration_ms: Math.round((b - a) * 1000), lines: [] }
  })
  try {
    await post('/music?output_format=mp3_44100_192', {
      model_id: 'music_v1',
      composition_plan: { positive_global_styles: MUSIC.global, negative_global_styles: MUSIC.negative, sections },
    }, out)
  } catch (e) {
    console.log('composition plan refused, retrying with a prompt:', e.message.slice(0, 200))
    const prompt = `${MUSIC.global.join(', ')}. ` + MUSIC.sections.map((s) => `${s.name} (${(SCENES[s.scene][1] - SCENES[s.scene][0]).toFixed(1)}s): ${s.styles.join(', ')}`).join('. ')
    await post('/music?output_format=mp3_44100_192', { model_id: 'music_v1', prompt, music_length_ms: DURATION * 1000, force_instrumental: true }, out)
  }
  report()
}

function report() {
  for (const l of LINES) {
    const f = path.join(DIR, 'voice', `${l.id}.mp3`)
    if (!fs.existsSync(f)) continue
    const d = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString())
    console.log(`${l.id.padEnd(4)} ${d.toFixed(2)}s / slot ${l.max}s ${d > l.max ? `-> sped up x${Math.min(1.2, d / l.max).toFixed(2)} in the mix` : ''}`)
  }
}

// ------------------------------------------------------------------ offline synthesis
async function synthLocal() {
  const SR = 48000
  const writeWav = (file, L, R = L) => {
    const n = L.length, buf = Buffer.alloc(44 + n * 4)
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8); buf.write('fmt ', 12)
    buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34)
    buf.write('data', 36); buf.writeUInt32LE(n * 4, 40)
    for (let i = 0; i < n; i++) {
      buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i])) * 32000), 44 + i * 4)
      buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i])) * 32000), 46 + i * 4)
    }
    fs.writeFileSync(file, buf)
    console.log('wrote', path.relative(HERE, file))
  }
  let seed = 9
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }
  const noise = () => rnd() * 2 - 1
  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12)
  const clamp01 = (x) => Math.max(0, Math.min(1, x))
  const smooth = (x) => x * x * (3 - 2 * x)
  // Simple stereo reverb: parallel combs + allpasses (Schroeder).
  function reverb(L, R, mix = 0.3, size = 1) {
    const combs = [1557, 1617, 1491, 1422, 1277, 1356].map((d) => Math.round(d * size * SR / 44100))
    const out = (x, spread) => {
      const y = new Float32Array(x.length)
      for (const d0 of combs) {
        const d = d0 + spread, b = new Float32Array(d)
        let k = 0, lp = 0
        for (let i = 0; i < x.length; i++) { const o = b[k]; lp = o * 0.7 + lp * 0.3; b[k] = x[i] + lp * 0.84; y[i] += o / combs.length; k = (k + 1) % d }
      }
      for (const d of [556, 441, 341]) {
        const b = new Float32Array(d); let k = 0
        for (let i = 0; i < y.length; i++) { const o = b[k]; const v = y[i] + o * 0.5; b[k] = v; y[i] = o - v * 0.5; k = (k + 1) % d }
      }
      return y
    }
    const wl = out(L, 0), wr = out(R, 23)
    for (let i = 0; i < L.length; i++) { L[i] = L[i] * (1 - mix) + wl[i] * mix * 2.2; R[i] = R[i] * (1 - mix) + wr[i] * mix * 2.2 }
  }

  // ---------------- score
  const N = Math.round(DURATION * SR)
  const L = new Float32Array(N), R = new Float32Array(N)
  // [start, chord (midi), level] -- D major / B minor colours, the build lands on the reveal at 11.25 s.
  const CH = [
    [0, [38, 50, 57, 62, 66], 0.35], [4, [35, 47, 54, 59, 62], 0.4], [8, [31, 43, 50, 55, 62], 0.5], [11.25, [38, 50, 57, 62, 66, 69], 0.9],
    [14, [38, 50, 57, 64, 66], 0.55], [18, [35, 47, 54, 62, 66], 0.55], [22, [31, 43, 55, 59, 62], 0.55], [25.5, [33, 45, 52, 57, 61], 0.55],
    [29, [38, 50, 57, 62, 66, 69], 0.7], [33, [43, 55, 59, 62, 67], 0.7], [36.5, [33, 45, 57, 61, 64], 0.7],
    [40, [35, 47, 54, 59, 62], 0.55], [44.45, [34, 46, 53, 58, 61], 0.35], [48.6, [31, 43, 55, 59, 62], 0.6], [51, [38, 50, 57, 62, 66], 0.7],
    [54.5, [31, 43, 55, 59, 62, 67], 0.7], [57.5, [33, 45, 57, 61, 64, 69], 0.8], [60.6, [38, 50, 57, 62, 66, 69, 74], 1.0],
  ]
  const chordAt = (t) => { let c = CH[0]; for (const x of CH) if (t >= x[0]) c = x; return c }
  const phases = new Float64Array(64)
  let lpL = 0, lpR = 0
  for (let i = 0; i < N; i++) {
    const t = i / SR
    const [t0, notes, lvl] = chordAt(t)
    const idx = CH.findIndex((c) => c[0] === t0)
    const prev = CH[Math.max(0, idx - 1)]
    const xf = smooth(clamp01((t - t0) / 0.6))
    let sl = 0, sr = 0
    const voice = (ns, g) => ns.forEach((m, j) => {
      for (const det of [-0.08, 0.08]) {
        const f = mtof(m + det)
        const k = (j * 2 + (det > 0 ? 1 : 0)) % 64
        phases[k] = (phases[k] + f / SR) % 1
        const saw = 2 * phases[k] - 1
        const v = (Math.sin(2 * Math.PI * phases[k]) * 0.6 + saw * 0.4) * g / ns.length
        if (det > 0) sr += v; else sl += v
      }
    })
    voice(notes, xf * lvl)
    if (xf < 1) voice(prev[1], (1 - xf) * prev[2])
    // global dynamics: hush at the freeze, swell into reveal and finale, fade at the end
    const dyn = (0.55 + 0.45 * smooth(clamp01((t - 0) / 6))) * (t > 44.45 && t < 45.4 ? 0.35 : 1) * (1 - smooth(clamp01((t - 63.5) / 2.5)))
    const cut = 900 + 2600 * (t > 11.25 ? 1 : smooth(clamp01((t - 8) / 3.25))) * (t > 60.6 ? 1.2 : 1)
    const a = Math.exp(-2 * Math.PI * cut / SR)
    lpL = (1 - a) * sl + a * lpL; lpR = (1 - a) * sr + a * lpR
    L[i] = lpL * 0.32 * dyn; R[i] = lpR * 0.32 * dyn
    // sub on the root
    const sub = Math.sin(2 * Math.PI * mtof(notes[0] - 12) * t) * 0.12 * lvl * dyn
    L[i] += sub; R[i] += sub
  }
  // plucked arpeggios (capture, map, teach resolution, trust) and a felt-piano motif in the opening
  const pluck = (t0, m, g, pan = 0, dec = 3.5) => {
    const s = Math.round(t0 * SR), f = mtof(m), len = Math.round(SR * 1.6)
    for (let j = 0; j < len && s + j < N; j++) {
      const tt = j / SR, env = Math.exp(-tt * dec) * Math.min(1, tt * 400)
      const v = (Math.sin(2 * Math.PI * f * tt) + 0.3 * Math.sin(4 * Math.PI * f * tt) + 0.1 * Math.sin(6 * Math.PI * f * tt)) * env * g
      L[s + j] += v * (1 - pan) * 0.5; R[s + j] += v * (1 + pan) * 0.5
    }
  }
  const piano = [[0.8, 74], [2.0, 69], [3.2, 66], [4.6, 71], [5.8, 66], [7.0, 62]]
  piano.forEach(([t, m]) => { pluck(t, m, 0.22, -0.2, 1.6); pluck(t, m - 12, 0.1, 0.2, 1.8) })
  const arp = (a, b, step, g, sp = 1) => {
    for (let t = a, k = 0; t < b; t += step, k++) {
      const ns = chordAt(t)[1].slice(-4)
      pluck(t, ns[(k * sp) % ns.length] + 12, g, k % 2 ? 0.4 : -0.4)
    }
  }
  arp(14.2, 28.8, 0.3, 0.07); arp(29.2, 39.6, 0.6, 0.08, 3); arp(40.2, 44.4, 0.3, 0.05); arp(48.8, 54.3, 0.3, 0.07); arp(54.6, 60.4, 0.15, 0.06, 2)
  // low pulse for the tension before the freeze
  for (let t = 40.2; t < 44.4; t += 0.5) pluck(t, 38, 0.25 * (0.4 + (t - 40) / 6), 0, 6)
  reverb(L, R, 0.35, 1.1)
  writeWav(path.join(DIR, 'music.wav'), L, R)

  // ---------------- sound effects
  const sfx = (dur, fn) => { const n = Math.round(dur * SR), l = new Float32Array(n), r = new Float32Array(n); fn(l, r, n); return [l, r] }
  const sweepNoise = (l, r, n, f0, f1, envf, q = 1.2) => {
    let s = [0, 0, 0, 0, 0, 0], s2 = [0, 0, 0, 0, 0, 0]
    for (let i = 0; i < n; i++) {
      const k = i / n, f = f0 * Math.pow(f1 / f0, k), w = 2 * Math.PI * f / SR, al = Math.sin(w) / (2 * q), a0 = 1 + al
      const filt = (st, x) => { const y = (al * x - al * st[1] + 2 * Math.cos(w) * st[2] - (1 - al) * st[3]) / a0; st[1] = st[0]; st[0] = x; st[3] = st[2]; st[2] = y; return y }
      l[i] += filt(s, noise()) * envf(k) * 2.2; r[i] += filt(s2, noise()) * envf(k) * 2.2
    }
  }
  const tone = (l, r, n, f, envf, start = 0, pan = 0) => { let ph = 0; for (let i = Math.round(start * SR); i < n; i++) { const k = (i / SR - start); ph += (typeof f === 'function' ? f(k) : f) / SR; const v = Math.sin(2 * Math.PI * ph) * envf(k); l[i] += v * (1 - pan); r[i] += v * (1 + pan) } }
  const make = {
    drone: () => sfx(8, (l, r, n) => { tone(l, r, n, 55, (k) => smooth(clamp01(k / 3)) * 0.3 * (1 - smooth(clamp01((k - 6) / 2)))); tone(l, r, n, 82.4, (k) => smooth(clamp01(k / 4)) * 0.12 * (1 - smooth(clamp01((k - 6) / 2)))); sweepNoise(l, r, n, 300, 600, (k) => Math.sin(Math.PI * k) * 0.05) }),
    dissolve: () => sfx(3, (l, r, n) => { for (let j = 0; j < 70; j++) { const st = rnd() * 2.2, f = 2000 + rnd() * 5000; tone(l, r, n, f, (k) => (k < 0 ? 0 : Math.exp(-k * 9) * 0.05 * Math.min(1, k * 300)), st, rnd() * 1.6 - 0.8) } sweepNoise(l, r, n, 6000, 2500, (k) => Math.sin(Math.PI * k) * 0.06) }),
    riser: () => sfx(2.6, (l, r, n) => { sweepNoise(l, r, n, 400, 9000, (k) => Math.pow(k, 2.2) * 0.5, 2); tone(l, r, n, (k) => 200 + 600 * Math.pow(k / 2.6, 2), (k) => Math.pow(k / 2.6, 3) * 0.12) }),
    impact: () => sfx(4, (l, r, n) => { tone(l, r, n, (k) => 30 + 70 * Math.exp(-k * 7), (k) => Math.exp(-k * 1.6) * 0.9 * Math.min(1, k * 600)); sweepNoise(l, r, n, 3000, 200, (k) => Math.exp(-k * 18) * 0.9, 0.7); for (const f of [1760, 2217, 2637, 3520]) tone(l, r, n, f, (k) => Math.exp(-k * 1.3) * 0.04 * Math.min(1, k * 50), 0.05, rnd() - 0.5) }),
    whoosh: () => sfx(1.5, (l, r, n) => sweepNoise(l, r, n, 300, 4000, (k) => Math.pow(Math.sin(Math.PI * Math.pow(k, 0.7)), 2) * 0.5, 1.5)),
    click: () => sfx(0.5, (l, r, n) => { sweepNoise(l, r, n, 4000, 2500, (k) => Math.exp(-k * 120) * 0.9, 1.5); tone(l, r, n, 1800, (k) => Math.exp(-k * 140) * 0.3) }),
    scan: () => sfx(2.5, (l, r, n) => { tone(l, r, n, (k) => 1400 + 900 * (k / 2.5), (k) => Math.sin(Math.PI * k / 2.5) * 0.05 * (0.6 + 0.4 * Math.sin(k * 60))); sweepNoise(l, r, n, 2000, 6000, (k) => Math.sin(Math.PI * k) * 0.04, 3) }),
    type: () => sfx(1.2, (l, r, n) => { for (const st of [0, 0.14, 0.3, 0.43]) { const [cl, cr] = make.click(); const s = Math.round(st * SR); for (let j = 0; j < cl.length && s + j < n; j++) { l[s + j] += cl[j] * 0.6; r[s + j] += cr[j] * 0.6 } } }),
    mask: () => sfx(1, (l, r, n) => { sweepNoise(l, r, n, 2500, 2500, (k) => Math.exp(-k * 90) * 0.6, 2); tone(l, r, n, 2637, (k) => Math.exp(-k * 8) * 0.08, 0.04); tone(l, r, n, 3520, (k) => Math.exp(-k * 8) * 0.06, 0.09) }),
    pop: () => sfx(0.7, (l, r, n) => { tone(l, r, n, (k) => 500 + 1400 * Math.min(1, k * 25), (k) => Math.exp(-k * 25) * 0.4); tone(l, r, n, 3136, (k) => Math.exp(-k * 10) * 0.05, 0.03) }),
    chime: () => sfx(1.2, (l, r, n) => { tone(l, r, n, 1318.5, (k) => Math.exp(-k * 5) * 0.16 * Math.min(1, k * 200)); tone(l, r, n, 1975.5, (k) => (k < 0 ? 0 : Math.exp(-k * 4) * 0.16 * Math.min(1, k * 200)), 0.13) }),
    crystal: () => sfx(5, (l, r, n) => { [0.9, 1.65, 2.4, 3.15].forEach((st, j) => { for (const f of [1567.98, 2349.3, 3135.96]) tone(l, r, n, f * Math.pow(2, j / 12 * 2), (k) => (k < 0 ? 0 : Math.exp(-k * 2.5) * 0.05 * Math.min(1, k * 150)), st, j % 2 ? 0.5 : -0.5) }) }),
    confirm: () => sfx(1.5, (l, r, n) => { [[0, 1046.5], [0.1, 1318.5], [0.2, 1568]].forEach(([st, f]) => { tone(l, r, n, f, (k) => (k < 0 ? 0 : Math.exp(-k * 3.5) * 0.14 * Math.min(1, k * 200)), st); tone(l, r, n, f * 2, (k) => (k < 0 ? 0 : Math.exp(-k * 6) * 0.03), st) }) }),
    stop: () => sfx(1.5, (l, r, n) => { tone(l, r, n, (k) => 220 * Math.exp(-k * 3), (k) => Math.exp(-k * 2.5) * 0.35); sweepNoise(l, r, n, 5000, 150, (k) => Math.exp(-k * 4) * 0.5, 0.8); tone(l, r, n, 45, (k) => Math.exp(-k * 2) * 0.5) }),
    guard: () => sfx(0.9, (l, r, n) => { tone(l, r, n, 1174.7, (k) => Math.exp(-k * 6) * 0.15 * Math.min(1, k * 200)); tone(l, r, n, 880, (k) => (k < 0 ? 0 : Math.exp(-k * 5) * 0.15 * Math.min(1, k * 200)), 0.16) }),
    fly: () => sfx(1.4, (l, r, n) => { sweepNoise(l, r, n, 600, 7000, (k) => Math.pow(Math.sin(Math.PI * k), 2) * 0.45, 1.3); for (let j = 0; j < 25; j++) tone(l, r, n, 3000 + rnd() * 4000, (k) => (k < 0 ? 0 : Math.exp(-k * 12) * 0.03), 0.2 + rnd() * 0.9, rnd() * 2 - 1) }),
    shield: () => sfx(2.5, (l, r, n) => { for (const f of [110, 220, 330.5, 440.6]) tone(l, r, n, f, (k) => smooth(clamp01(k / 0.5)) * Math.exp(-k * 0.8) * 0.06); sweepNoise(l, r, n, 1500, 5000, (k) => Math.sin(Math.PI * k) * 0.05, 4) }),
    finale: () => make.impact(),
  }
  for (const s of SFX.filter((s) => !s.ref)) {
    const [l, r] = (make[s.id] || make.pop)()
    reverb(l, r, s.id === 'click' || s.id === 'type' ? 0.08 : 0.25, 0.8)
    writeWav(path.join(DIR, 'sfx', `${s.id}.wav`), l, r)
  }
}
