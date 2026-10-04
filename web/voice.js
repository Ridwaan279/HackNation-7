// The ghost's voice. Kickstart starts it; it then talks through each step of the site.
// With an ElevenLabs agent id (config.js) it is a live conversation that can move the page with client tools.
// Without one, a browser voice reads the short scripts below. The SDK loads on the first use.
import config from './config.js'

const SDK = 'https://cdn.jsdelivr.net/npm/@elevenlabs/client@1.26.0/dist/lib.iife.js'

/** Browser-voice scripts: [line, cue]. A cue moves the page while its line is spoken (app.js cue()). */
const SCRIPTS = {
  intro: [
    ["Hi, I'm the apprentice. I learn how your experts do their work, and I teach it to whoever comes next.", null],
    ['You can use me in two ways.', 'options'],
    ['On the left, the web app. It runs right here in your browser. It records your screen, takes a screenshot whenever it changes, and writes down what you say.', 'web'],
    ["On the right, the desktop app. It sees what you're doing in real time: every field, every click, and what you typed, masked. So I can ask why at the right moments, and learn the whole job, even the exceptions.", 'desktop'],
    ['I recommend the desktop app. Pick one to continue.', 'recommend'],
  ],
  web: [
    ["Here's how the web app works. Press New recording, and choose the window you work in.", null],
    ["Spend the first ten seconds saying what you're going to show. Then just work, and talk me through it.", null],
    ['When you stop, you get a guide: a screenshot for every step, with your words next to it. Open the dashboard to begin.', 'dashboard'],
  ],
  desktop: [
    ['Good choice. The desktop app runs on Windows.', null],
    ['Download the zip, unzip it, and double-click start dot bat. The first start installs everything it needs.', 'install'],
    ['Then I sit with you while you work, ask why at the pauses, and keep learning every app, without ever reading a password.', 'download'],
  ],
}

/** What the live agent hears when the visitor moves on. The agent's prompt says to answer these out loud. */
const AGENT_NOTES = {
  web: '[Website: the visitor chose the web app. In two short sentences, explain how it works: press New recording, choose a window, introduce the task in the first ten seconds, talk while working, get a guide. Then tell them to open the dashboard.]',
  desktop: '[Website: the visitor chose the desktop app. In two short sentences, say how to install it: download the zip, unzip it and double-click start.bat; it needs Node.js and Python. Then say what it adds: it sees every field in real time, asks why, and keeps learning.]',
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
 * ui: {
 *   state(s), level(0..1), caption(who, text), clearCaptions(), previewNote(on), error(text),
 *   cue(name)                 move the page for a browser-voice line,
 *   tool(name, arg) → string  run an agent client tool and describe what is now on screen,
 * }
 */
export function createVoice(ui) {
  let session = null
  let preview = null
  let state = 'idle'
  let frame = 0
  /** The visitor wants the voice (Kickstart, or the voice button); later steps are narrated too. */
  let narrating = false

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
      ui.error(/permission|denied|notallowed/i.test(text) ? 'Allow the microphone to talk to the ghost.' : `The ghost couldn't connect: ${text}`)
    }
  }

  function stopPreview() {
    if (!preview) return
    preview = null
    window.speechSynthesis?.cancel()
  }

  async function play(name) {
    const lines = SCRIPTS[name]
    const synth = window.speechSynthesis
    if (!lines) return
    if (!synth) { ui.error("This browser can't speak. The page explains everything too."); return }
    stopPreview()
    const token = {}
    preview = token
    ui.previewNote(true)
    set('connecting')
    const voice = await pickVoice(synth)
    if (preview !== token) return
    let i = 0
    set('speaking')
    // The browser voice has no level meter: a gentle pulse stands in for it.
    meter(() => 0.35 + 0.35 * Math.abs(Math.sin(performance.now() / 160) * Math.sin(performance.now() / 410)))
    const next = () => {
      if (preview !== token) return
      if (i >= lines.length) { preview = null; stopMeter(); set('idle'); return }
      const [text, cue] = lines[i++]
      if (cue) ui.cue(cue)
      ui.caption('ghost', text)
      const utterance = new SpeechSynthesisUtterance(text)
      if (voice) utterance.voice = voice
      utterance.rate = 1.03
      const started = performance.now()
      // No voice installed: the line fails at once, so give people time to read it.
      const after = () => setTimeout(next, Math.max(300, text.length * 55 - (performance.now() - started)))
      utterance.onend = after
      utterance.onerror = after
      synth.speak(utterance)
    }
    next()
  }

  async function stop() {
    stopMeter()
    stopPreview()
    if (session) {
      const s = session
      session = null
      try { await s.endSession() } catch { /* already closed */ }
    }
    set('idle')
  }

  return {
    get active() { return state !== 'idle' },
    /** Kickstart: the ghost introduces the two versions. */
    kickstart() {
      narrating = true
      ui.clearCaptions()
      if (config.elevenLabsAgentId) return session ? undefined : startAgent()
      return play('intro')
    },
    /** The visitor moved on to a step: narrate it, if they wanted the voice. */
    narrate(name) {
      if (!narrating) return
      if (config.elevenLabsAgentId) {
        if (session && AGENT_NOTES[name]) { try { session.sendUserMessage(AGENT_NOTES[name]) } catch { /* closed */ } }
        return
      }
      void play(name)
    },
    /** The voice button: stop, or start again for the step on screen. */
    toggle(name) {
      if (state !== 'idle') { narrating = false; return stop() }
      narrating = true
      ui.clearCaptions()
      return config.elevenLabsAgentId ? startAgent() : play(name)
    },
    stop() { narrating = false; return stop() },
  }
}
