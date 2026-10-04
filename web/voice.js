// "Ask the ghost": an ElevenLabs voice agent that explains what the desktop app adds and points at the page.
// The SDK loads on the first click. Without an agent id (config.js), a browser voice reads a short script.
import config from './config.js'

const SDK = 'https://cdn.jsdelivr.net/npm/@elevenlabs/client@1.26.0/dist/lib.iife.js'

/** What the browser preview says, and which part of the page it shows while saying it. */
const SCRIPT = [
  ["Hi, I'm the apprentice.", null],
  ['This web page only sees the pixels of the screen you share. So it takes screenshots, and writes down what you say.', 'how'],
  ['The desktop app reads every field through Windows accessibility, so each step says which field you changed and what you typed. Passwords are never read, and card numbers and IBANs are masked before anything is saved.', 'compare'],
  ['While you work, I ask why at the natural pauses, out loud, and turn your answers into a Work Map of your rules.', 'desktop'],
  ['And because I keep learning every app in the background, I can sit next to your new hire, point at the right field, and stop a mistake before it is saved.', 'teach'],
  ["It's free. You can download it right here.", 'download'],
]

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

/** Browsers load their voices late; wait briefly for them. */
function pickVoice(synth) {
  const choose = () => {
    const voices = synth.getVoices()
    return voices.find((v) => /^en/i.test(v.lang) && /natural|neural|aria|jenny|samantha|daniel|google uk|google us/i.test(v.name))
      ?? voices.find((v) => /^en/i.test(v.lang))
      ?? null
  }
  const now = choose()
  if (now || !('onvoiceschanged' in synth)) return Promise.resolve(now)
  return new Promise((resolve) => {
    const done = () => { synth.removeEventListener('voiceschanged', done); resolve(choose()) }
    synth.addEventListener('voiceschanged', done)
    setTimeout(done, 700)
  })
}

/**
 * ui: { state(s), level(0..1), caption(who, text), clearCaptions(), show(section, pulse) → string, error(text), previewNote(on) }
 */
export function createVoice(ui) {
  let session = null
  let preview = null
  let state = 'idle'
  let frame = 0

  const set = (next) => { state = next; ui.state(next) }
  const meter = (read) => {
    cancelAnimationFrame(frame)
    const loop = () => { ui.level(Math.max(0, Math.min(1, read()))); frame = requestAnimationFrame(loop) }
    frame = requestAnimationFrame(loop)
  }
  const stopMeter = () => { cancelAnimationFrame(frame); ui.level(0) }

  async function startAgent() {
    set('connecting')
    try {
      const { Conversation } = await loadSdk()
      session = await Conversation.startSession({
        agentId: config.elevenLabsAgentId,
        connectionType: 'webrtc',
        clientTools: {
          show_section: ({ section } = {}) => ui.show(String(section ?? '')),
          highlight_download: () => ui.show('download', true),
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
      stopMeter()
      set('idle')
      const text = String(failure?.message ?? failure)
      ui.error(/permission|denied|notallowed/i.test(text) ? 'Allow the microphone to talk to the ghost.' : `The ghost couldn't connect: ${text}`)
    }
  }

  async function startPreview() {
    const synth = window.speechSynthesis
    if (!synth) { ui.error("This browser can't speak. Read on, or download the app."); return }
    ui.previewNote(true)
    set('connecting')
    const voice = await pickVoice(synth)
    let canceled = false
    let i = 0
    const next = () => {
      if (canceled) return
      if (i >= SCRIPT.length) { void stop(); return }
      const [text, section] = SCRIPT[i++]
      if (section) ui.show(section, section === 'download')
      ui.caption('ghost', text)
      const utterance = new SpeechSynthesisUtterance(text)
      if (voice) utterance.voice = voice
      utterance.rate = 1.03
      const started = performance.now()
      // No voice installed: the line fails at once, so give people time to read it.
      const after = () => setTimeout(next, Math.max(280, text.length * 55 - (performance.now() - started)))
      utterance.onend = after
      utterance.onerror = after
      synth.speak(utterance)
    }
    preview = { cancel() { canceled = true; synth.cancel() } }
    set('speaking')
    // The browser voice has no level meter: a gentle pulse stands in for it.
    meter(() => 0.35 + 0.35 * Math.abs(Math.sin(performance.now() / 160) * Math.sin(performance.now() / 410)))
    next()
  }

  async function stop() {
    stopMeter()
    if (preview) { preview.cancel(); preview = null }
    if (session) {
      const s = session
      session = null
      try { await s.endSession() } catch { /* already closed */ }
    }
    set('idle')
  }

  return {
    get active() { return state !== 'idle' },
    async toggle() {
      if (state !== 'idle') return stop()
      ui.clearCaptions()
      return config.elevenLabsAgentId ? startAgent() : startPreview()
    },
    stop,
  }
}
