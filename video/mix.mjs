// Mixes the stems in video/audio/ (ElevenLabs .mp3 if present, else the local .wav) and muxes them onto out/silent.mp4.
// Voices sit on top; the music ducks under them; the result is loudness-normalised to -14 LUFS.
//
//   node mix.mjs                 -> out/protege-demo.mp4
//   node mix.mjs --video other.mp4

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DURATION, LINES, SFX } from './cues.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const A = path.join(HERE, 'audio'), OUT = path.join(HERE, 'out')
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > -1 ? process.argv[i + 1] : d }
const stem = (base) => ['.mp3', '.wav'].map((e) => base + e).find((f) => fs.existsSync(f))
const dur = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString())

const inputs = [], filters = [], voiceLabels = [], fxLabels = []
const input = (f) => { inputs.push('-i', f); return inputs.length / 2 - 1 }

const music = stem(path.join(A, 'music'))
if (!music) throw new Error('No music stem. Run `node audio.mjs` (ElevenLabs) or `node audio.mjs --local` first.')
const mi = input(music)
filters.push(`[${mi}:a]aresample=48000,atrim=0:${DURATION},volume=-6dB,afade=t=in:d=0.6,afade=t=out:st=${DURATION - 3}:d=3[mus]`)

for (const l of LINES) {
  const f = stem(path.join(A, 'voice', l.id))
  if (!f) continue
  const d = dur(f), tempo = Math.min(1.2, Math.max(1, d / l.max))
  const i = input(f), ms = Math.round(l.t * 1000)
  const gain = l.voice === 'narrator' ? 0 : -1
  filters.push(`[${i}:a]aresample=48000,atempo=${tempo.toFixed(3)},volume=${gain}dB,highpass=f=70,adelay=${ms}|${ms},apad[v${voiceLabels.length}]`)
  voiceLabels.push(`[v${voiceLabels.length}]`)
}
for (const s of SFX) {
  const f = stem(path.join(A, 'sfx', s.ref || s.id))
  if (!f) continue
  const i = input(f), ms = Math.round(s.t * 1000)
  filters.push(`[${i}:a]aresample=48000,volume=${s.gain}dB,adelay=${ms}|${ms},apad[f${fxLabels.length}]`)
  fxLabels.push(`[f${fxLabels.length}]`)
}

let musicOut = '[mus]'
const parts = []
if (voiceLabels.length) {
  filters.push(`${voiceLabels.join('')}amix=inputs=${voiceLabels.length}:normalize=0:duration=longest,atrim=0:${DURATION}[vox]`)
  filters.push('[vox]asplit=2[voxA][voxB]')
  filters.push('[mus][voxB]sidechaincompress=threshold=0.03:ratio=6:attack=40:release=450:makeup=1[musd]')
  musicOut = '[musd]'
  parts.push('[voxA]')
}
parts.push(musicOut)
if (fxLabels.length) {
  filters.push(`${fxLabels.join('')}amix=inputs=${fxLabels.length}:normalize=0:duration=longest,atrim=0:${DURATION}[sfx]`)
  parts.push('[sfx]')
}
filters.push(`${parts.join('')}amix=inputs=${parts.length}:normalize=0:duration=first,atrim=0:${DURATION},loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[out]`)

fs.mkdirSync(OUT, { recursive: true })
const wav = path.join(OUT, 'mix.wav')
let r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', filters.join(';'), '-map', '[out]', '-ac', '2', '-ar', '48000', wav], { stdio: 'inherit' })
if (r.status) process.exit(r.status)
console.log(`mixed ${voiceLabels.length} voice clips, ${fxLabels.length} sound effects -> ${path.relative(HERE, wav)}`)

const video = arg('video', path.join(OUT, 'silent.mp4'))
if (fs.existsSync(video)) {
  const out = path.join(OUT, 'protege-demo.mp4')
  r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', video, '-i', wav, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart', '-shortest', out], { stdio: 'inherit' })
  if (r.status) process.exit(r.status)
  console.log(`wrote ${path.relative(HERE, out)}`)
} else console.log(`no video at ${video}; render it with \`node render.mjs\``)
