// Protégé's voice on the website.
// Speech: ElevenLabs text-to-speech through api/tts (a Vercel function that keeps the API key on the server);
// where that isn't deployed, the most natural voice the browser has.
// The explanations (Kickstart, opening the web or desktop version) are always the written script, read
// word for word and never waiting for an answer. With an ElevenLabs agent id (config.js), the voice button
// starts a live conversation for questions, which can move the page with client tools.
import config from './config.js'

const SDK = 'https://cdn.jsdelivr.net/npm/@elevenlabs/client@1.26.0/dist/lib.iife.js'
const TTS = 'api/tts'

/** Spoken tours: [line, cue]. A cue moves the page while its line is spoken (app.js cue()). */
const SCRIPTS = {
  intro: [
    ["Hi, I'm Protégé. I learn how your experts do their work, and I teach it to whoever comes next.", null],
    ['You can use me in two ways.', 'options'],
    ["On the left, the web app. It's a traditional onboarding recording: you record a task, I ask questions when something needs explaining, and at the end I sum it up and ask what's missing.", 'web'],
    ["On the right, the desktop app. It doesn't stop when the recording does. It runs all the time, reads every task through Windows accessibility, and keeps training itself, so it catches the things an expert forgets to explain.", 'desktop'],
    ["That's the one I recommend. It's where we pushed this idea to its limit. Pick one to continue.", 'recommend'],
  ],
  web: [
    ["Here's the web app. It works like a traditional onboarding session.", null],
    ["Press New recording, choose the window you work in, and spend the first ten seconds saying what you're going to show.", null],
    ["While you work, I'll ask a question whenever something needs explaining. Just answer out loud.", null],
    ["When you stop, I'll sum up what I saw and ask a few last questions. Then your guide is ready. Open the dashboard to begin.", 'dashboard'],
  ],
  desktop: [
    ['This is the desktop app, the full version of me.', null],
    ["Unlike the web app, I don't only learn while you record. I run all the time, and I read every field, click and value through Windows accessibility, masked, so I see the whole job.", 'features'],
    ['I keep training myself, and I fill in what an expert forgets to mention, which is exactly where traditional onboarding falls short.', null],
    ["This is where we pushed the idea to its limit, and it's only possible because I run on your computer, not in a browser.", 'moonshot'],
    ["Download the zip, unzip it, and double-click start dot bat. That's all.", 'download'],
  ],
}

// ------------------------------------------------------------------ speaking one line

let tts = null // null: not tried yet; true: ElevenLabs works; false: use the browser's voice
const audioCache = new Map()
let audio = null
let analyser = null

function fetchSpeech(text) {
  if (tts === false) return Promise.resolve(null)
  if (!audioCache.has(text)) {
    audioCache.set(text, fetch(`${TTS}?text=${encodeURIComponent(text)}`)
      .then((r) => {
        if (!r.ok || !(r.headers.get('content-type') ?? '').includes('audio')) throw new Error(String(r.status))
        tts = true
        return r.blob()
      })
      .catch(() => { tts = false; audioCache.delete(text); return null }))
  }
  return audioCache.get(text)
}

function ensureAudio() {
  if (audio) return
  audio = new Audio()
  try {
    const ctx = new AudioContext()
    const source = ctx.createMediaElementSource(audio)
    analyser = ctx.createAnalyser()
    analyser.fftSize = 256
    source.connect(analyser)
    analyser.connect(ctx.destination)
    audio.addEventListener('play', () => void ctx.resume())
  } catch {
    analyser = null
  }
}

function outputLevel() {
  if (!analyser) return 0.45
  const data = new Uint8Array(analyser.fftSize)
  analyser.getByteTimeDomainData(data)
  let sum = 0
  for (const v of data) sum += ((v - 128) / 128) ** 2
  return Math.min(1, Math.sqrt(sum / data.length) * 5)
}

/** The most natural voice the browser offers. Browsers load voices late, so wait briefly. */
let browserVoice
function pickVoice() {
  const synth = window.speechSynthesis
  if (browserVoice !== undefined || !synth) return Promise.resolve(browserVoice ?? null)
  const choose = () => {
    const voices = synth.getVoices().filter((v) => /^en/i.test(v.lang))
    const prefer = [/(Aria|Jenny|Ava|Emma|Andrew|Brian).*Natural/i, /Natural/i, /Google UK English Female/i, /Google US English/i, /Samantha|Serena|Karen|Moira|Daniel/i]
    for (const re of prefer) { const v = voices.find((x) => re.test(x.name)); if (v) return v }
    return voices[0] ?? null
  }
  const now = choose()
  if (now) { browserVoice = now; return Promise.resolve(now) }
  return new Promise((resolve) => {
    const done = () => { synth.removeEventListener('voiceschanged', done); browserVoice = choose(); resolve(browserVoice) }
    synth.addEventListener('voiceschanged', done)
    setTimeout(done, 800)
  })
}

// ------------------------------------------------------------------ the voice

/**
 * ui: {
 *   state(s), level(0..1), caption(who, text), clearCaptions(), previewNote(on), error(text),
 *   cue(name)                 move the page while a tour line is spoken,
 *   tool(name, arg) → string  run an agent client tool and describe what is now on screen,
 * }
 */
export function createVoice(ui) {
  let session = null
  let state = 'idle'
  let frame = 0
  let current = null // { cancelled, finish } for the line or tour being spoken
  /** The visitor wants the voice (Kickstart, or the voice button); later steps are narrated too. */
  let narrating = false

  const set = (next) => { state = next; ui.state(next) }
  const meter = (read) => {
    cancelAnimationFrame(frame)
    const loop = () => { ui.level(Math.max(0, Math.min(1, read()))); frame = requestAnimationFrame(loop) }
    frame = requestAnimationFrame(loop)
  }
  const stopMeter = () => { cancelAnimationFrame(frame); ui.level(0) }

  function cancelSpeech() {
    if (!current) return
    current.cancelled = true
    current.finish?.()
    current = null
    if (audio) audio.pause()
    window.speechSynthesis?.cancel()
  }

  /** Speak one line; resolves when it has been said (or cancelled). */
  async function speakLine(text, job) {
    const blob = await fetchSpeech(text)
    if (job.cancelled) return
    if (blob) {
      ensureAudio()
      ui.previewNote(false)
      const url = URL.createObjectURL(blob)
      audio.src = url
      meter(outputLevel)
      await new Promise((resolve) => {
        job.finish = resolve
        audio.onended = resolve
        audio.onerror = resolve
        audio.play().catch(resolve)
      })
      URL.revokeObjectURL(url)
      return
    }
    const synth = window.speechSynthesis
    if (!synth) { await new Promise((r) => { job.finish = r; setTimeout(r, text.length * 55) }); return }
    ui.previewNote(true)
    const voice = await pickVoice()
    if (job.cancelled) return
    meter(() => 0.35 + 0.35 * Math.abs(Math.sin(performance.now() / 160) * Math.sin(performance.now() / 410)))
    await new Promise((resolve) => {
      job.finish = resolve
      const utterance = new SpeechSynthesisUtterance(text)
      if (voice) utterance.voice = voice
      utterance.rate = 0.98
      const started = performance.now()
      // A browser without voices fails at once: give people time to read the caption.
      const done = () => setTimeout(resolve, Math.max(0, text.length * 55 - (performance.now() - started)))
      utterance.onend = done
      utterance.onerror = done
      synth.speak(utterance)
    })
  }

  /** Speak a list of lines, with cues and captions. */
  async function run(lines) {
    cancelSpeech()
    const job = { cancelled: false }
    current = job
    set('speaking')
    for (let i = 0; i < lines.length; i++) {
      const [text, cue] = lines[i]
      if (job.cancelled) return
      if (lines[i + 1]) void fetchSpeech(lines[i + 1][0]) // fetch the next line while this one plays
      if (cue) ui.cue(cue)
      ui.caption('ghost', text)
      await speakLine(text, job)
      if (!job.cancelled) await new Promise((r) => setTimeout(r, 220))
    }
    if (current === job) { current = null; stopMeter(); set('idle') }
  }

  async function startAgent() {
    set('connecting')
    try {
      const { Conversation } = await loadSdk()
      session = await Conversation.startSession({
        agentId: config.elevenLabsAgentId,
        connectionType: 'webrtc',
        clientTools: {
          show_options: () => ui.tool('options'),
          highlight_download: () => ui.tool('highlight_download'),
          open_mode: ({ mode } = {}) => ui.tool('open_mode', String(mode ?? '')),
        },
        onConnect: () => set('listening'),
        onDisconnect: () => { session = null; stopMeter(); set('idle') },
        onError: (message) => ui.error(typeof message === 'string' ? message : 'The voice agent had a problem.'),
        onModeChange: ({ mode }) => { if (session) set(mode === 'speaking' ? 'speaking' : 'listening') },
        onMessage: ({ message, role, source }) => ui.caption((role ?? source) === 'user' ? 'you' : 'ghost', message),
      })
      meter(() => { try { return session ? session.getOutputVolume() * 1.6 : 0 } catch { return 0 } })
    } catch (failure) {
      session = null
      narrating = false
      stopMeter()
      set('idle')
      const text = String(failure?.message ?? failure)
      ui.error(/permission|denied|notallowed/i.test(text) ? 'Allow the microphone to talk to Protégé.' : `Protégé couldn't connect: ${text}`)
    }
  }

  async function stop() {
    cancelSpeech()
    stopMeter()
    if (session) {
      const s = session
      session = null
      try { await s.endSession() } catch { /* already closed */ }
    }
    set('idle')
  }

  return {
    get active() { return state !== 'idle' },
    get narrating() { return narrating },
    /** Kickstart: Protégé introduces the two versions, exactly as written. */
    async kickstart() {
      narrating = true
      ui.clearCaptions()
      if (session) await stop() // a live chat would talk over the tour
      return run(SCRIPTS.intro)
    },
    /** A version page opened: explain it from the start, exactly as written, if the visitor wanted the voice. */
    async narrate(name) {
      if (!narrating || !SCRIPTS[name]) return
      if (session) await stop()
      return run(SCRIPTS[name])
    },
    /** The voice button: stop, or start again for the step on screen. */
    toggle(name) {
      if (state !== 'idle') { narrating = false; return stop() }
      narrating = true
      ui.clearCaptions()
      return config.elevenLabsAgentId ? startAgent() : run(SCRIPTS[name] ?? SCRIPTS.intro)
    },
    /** Say something during a recording (questions, the overview). Resolves when it has been said. */
    async say(text) {
      cancelSpeech()
      const job = { cancelled: false }
      current = job
      await speakLine(text, job)
      if (current === job) { current = null; stopMeter() }
      return !job.cancelled
    },
    /** Warm the speech cache for a line that is coming up. */
    prepare(text) { void fetchSpeech(text) },
    stop() { narrating = false; return stop() },
  }
}

function loadSdk() {
  if (window.ElevenLabsClient) return Promise.resolve(window.ElevenLabsClient)
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = SDK
    script.async = true
    script.onload = () => (window.ElevenLabsClient ? resolve(window.ElevenLabsClient) : reject(new Error('the voice library did not load')))
    script.onerror = () => reject(new Error('the voice library could not be downloaded'))
    document.head.append(script)
  })
}
