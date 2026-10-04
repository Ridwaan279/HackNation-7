// Apprentice website. Home: the banner and a Kickstart button. Kickstart starts the ghost's voice and opens the
// choice between the web app and the desktop app; each has a short overview, then the web dashboard or the download.
// The web recorder only sees the pixels of the screen you share, so it keeps a screenshot whenever the screen
// changes and writes down what you say. Recordings stay in this browser (IndexedDB). Nothing is uploaded.
import config from './config.js'
import { createVoice } from './voice.js'

/** The expert introduces the task first; screenshots start after this many seconds. */
const INTRO_S = 10
const MAX_SHOTS = 300
const SHOT_MAX_W = 1600
const THUMB_W = 480
const DIFF_W = 64
const DIFF_H = 36
/** A screenshot is kept when this share of a 64×36 thumbnail changed by more than PIXEL_DELTA. */
const CHANGE_FRACTION = 0.008
const PIXEL_DELTA = 22
const DEFAULT_OPTIONS = { mic: true, transcript: true, video: true, interval: 5 }
const VIEWS = ['home', 'choose', 'web', 'desktop', 'dashboard', 'live', 'guide']
/** Views where the voice button floats in the corner. */
const VOICE_VIEWS = ['choose', 'web', 'desktop', 'dashboard']

const $ = (id) => document.getElementById(id)
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
const canShare = !!navigator.mediaDevices?.getDisplayMedia

/** The recording in progress, or null. */
let rec = null
/** The open guide: { id, title, intro, created, duration, hasVideo, steps: [{ id, t, image, title, note }] } */
let guide = null
let videoBlob = null
let videoUrl = ''
/** All recordings, newest first: [{ id, title, created, duration, count, thumb }] */
let recordings = []
let options = { ...DEFAULT_OPTIONS }
let currentView = ''

// ------------------------------------------------------------------ helpers

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
const uid = () => Math.random().toString(36).slice(2, 10)
const countWords = (text) => text.split(/\s+/).filter(Boolean).length
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'guide'
const shortDate = (t) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
const store = {
  get(key) { try { return JSON.parse(localStorage.getItem(key) ?? 'null') } catch { return null } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* storage may be blocked */ } },
}

function toast(text) {
  const box = $('toast')
  box.textContent = text
  box.hidden = false
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => { box.hidden = true }, 4200)
}

function download(blob, name) {
  const url = URL.createObjectURL(blob)
  const a = Object.assign(document.createElement('a'), { href: url, download: name })
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props)
  node.append(...children.filter((c) => c != null))
  return node
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('class', 'i')
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use')
  use.setAttribute('href', `#i-${name}`)
  svg.append(use)
  return svg
}

function autoGrow(area) {
  area.style.height = 'auto'
  area.style.height = `${area.scrollHeight + 2}px`
}

function restart(node, className) {
  node.classList.remove(className)
  void node.offsetWidth
  node.classList.add(className)
}

// ------------------------------------------------------------------ storage: one entry per recording (IndexedDB)
// index → summaries; guide:<id> → the guide without images; img:<id>:<step> → a screenshot; video:<id> → the video.

let dbPromise = null
function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('apprentice-web', 1)
    req.onupgradeneeded = () => req.result.createObjectStore('kv')
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}
async function idb(mode, fn) {
  const d = await db()
  return new Promise((resolve, reject) => {
    const tx = d.transaction('kv', mode)
    const req = fn(tx.objectStore('kv'))
    tx.oncomplete = () => resolve(req?.result)
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}
const idbGet = (key) => idb('readonly', (s) => s.get(key))
const docOnly = (g) => ({ ...g, steps: g.steps.map(({ image, ...rest }) => rest) })
const summary = (g, thumb) => ({ id: g.id, title: g.title, created: g.created, duration: g.duration, count: g.steps.length, thumb })

async function makeThumb(dataUrl) {
  if (!dataUrl) return ''
  const img = new Image()
  img.src = dataUrl
  await img.decode().catch(() => undefined)
  if (!img.width) return ''
  const c = document.createElement('canvas')
  c.width = Math.min(THUMB_W, img.width)
  c.height = Math.round(img.height * (c.width / img.width))
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height)
  return c.toDataURL('image/jpeg', 0.76)
}

/** Recordings saved by the first version of this page (one guide only) move into the list. */
async function migrate() {
  const old = await idbGet('guide')
  if (!old?.steps) return
  const images = {}
  for (const st of old.steps) images[st.id] = (await idbGet(`img:${st.id}`)) ?? ''
  const video = (await idbGet('video')) ?? null
  const thumb = await makeThumb(images[old.steps[0]?.id])
  await idb('readwrite', (s) => {
    s.put(old, `guide:${old.id}`)
    for (const st of old.steps) { s.put(images[st.id], `img:${old.id}:${st.id}`); s.delete(`img:${st.id}`) }
    if (video) s.put(video, `video:${old.id}`)
    s.delete('guide')
    s.delete('video')
    s.put([summary(old, thumb)], 'index')
  })
}

async function loadIndex() {
  try {
    if (!(await idbGet('index'))) await migrate()
    recordings = (await idbGet('index')) ?? []
  } catch {
    recordings = [] // private windows can refuse IndexedDB: the page still works for this visit
  }
}

async function saveRecording(g, blob) {
  const thumb = await makeThumb(g.steps[0]?.image)
  recordings = [summary(g, thumb), ...recordings.filter((r) => r.id !== g.id)]
  try {
    await idb('readwrite', (s) => {
      s.put(docOnly(g), `guide:${g.id}`)
      for (const st of g.steps) s.put(st.image, `img:${g.id}:${st.id}`)
      if (blob) s.put(blob, `video:${g.id}`)
      s.put(recordings, 'index')
    })
  } catch {
    toast("This browser couldn't keep the recording. Download the guide before you close the tab.")
  }
}

async function openGuide(id) {
  if (guide?.id === id) return guide
  try {
    const doc = await idbGet(`guide:${id}`)
    if (!doc?.steps) return null
    for (const st of doc.steps) st.image = (await idbGet(`img:${id}:${st.id}`)) ?? ''
    guide = doc
    videoBlob = (await idbGet(`video:${id}`)) ?? null
    return guide
  } catch {
    return null
  }
}

let saveTimer = 0
function saveSoon() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    if (!guide) return
    const entry = recordings.find((r) => r.id === guide.id)
    if (entry) { entry.title = guide.title; entry.count = guide.steps.length }
    idb('readwrite', (s) => { s.put(docOnly(guide), `guide:${guide.id}`); s.put(recordings, 'index') }).catch(() => undefined)
  }, 400)
}

async function deleteRecording(id) {
  const doc = await idbGet(`guide:${id}`).catch(() => null)
  recordings = recordings.filter((r) => r.id !== id)
  await idb('readwrite', (s) => {
    for (const st of doc?.steps ?? []) s.delete(`img:${id}:${st.id}`)
    s.delete(`guide:${id}`)
    s.delete(`video:${id}`)
    s.put(recordings, 'index')
  }).catch(() => undefined)
  if (guide?.id === id) { guide = null; videoBlob = null }
}

// ------------------------------------------------------------------ routing

function parseHash() {
  const [name = 'home', arg = ''] = location.hash.replace(/^#\/?/, '').split('/')
  return { name: VIEWS.includes(name) ? name : 'home', arg: decodeURIComponent(arg) }
}

function goto(path) {
  if (location.hash !== `#/${path}`) history.pushState(null, '', `#/${path}`)
  void route()
}

async function route() {
  let { name, arg } = parseHash()
  if (rec) name = 'live' // while recording, the live view is the only place to be
  else if (name === 'live') name = 'dashboard'
  const changed = name !== currentView
  currentView = name
  for (const view of document.querySelectorAll('[data-view]')) view.hidden = view.dataset.view !== name
  $('island').hidden = name === 'live'
  $('island').classList.toggle('minimal', name === 'home')
  for (const a of document.querySelectorAll('[data-nav]')) {
    if (a.dataset.nav === name || (a.dataset.nav === 'dashboard' && name === 'guide')) a.setAttribute('aria-current', 'page')
    else a.removeAttribute('aria-current')
  }
  $('voice-dock').classList.toggle('away', !VOICE_VIEWS.includes(name))
  if (!VOICE_VIEWS.includes(name)) $('dock-caption').hidden = true
  if (changed) {
    window.scrollTo({ top: 0, behavior: 'instant' })
    setMenu(false)
  }
  if (name === 'dashboard') renderDashboard()
  if (name === 'guide') {
    const found = await openGuide(arg)
    if (currentView !== 'guide') return
    if (found) renderGuide()
    else { $('guide-empty').hidden = false; $('guide-body').hidden = true }
  }
  observeReveals()
}

const revealer = 'IntersectionObserver' in window
  ? new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      entry.target.classList.add('in')
      revealer.unobserve(entry.target)
    }
  }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' })
  : null

function observeReveals() {
  for (const node of document.querySelectorAll('.rv:not(.in)')) {
    if (!revealer) { node.classList.add('in'); continue }
    if (!node.closest('[hidden]')) revealer.observe(node)
  }
}

function setMenu(open) {
  const menu = $('menu')
  $('burger').setAttribute('aria-expanded', String(open))
  $('burger').setAttribute('aria-label', open ? 'Close menu' : 'Open menu')
  if (open) {
    menu.hidden = false
    requestAnimationFrame(() => requestAnimationFrame(() => menu.classList.add('open')))
  } else if (!menu.hidden) {
    menu.classList.remove('open')
    setTimeout(() => { if (!menu.classList.contains('open')) menu.hidden = true }, 350)
  }
}

// ------------------------------------------------------------------ the ghost's voice

let cueTimer = 0
/** Move the page to what the ghost is talking about. */
function cue(name) {
  const web = $('choice-web')
  const desk = $('choice-desktop')
  const focus = (on, off) => {
    clearTimeout(cueTimer)
    on.classList.add('cue')
    on.classList.remove('dim')
    off.classList.add('dim')
    off.classList.remove('cue')
    on.scrollIntoView({ behavior: 'smooth', block: 'center' })
    cueTimer = setTimeout(() => { on.classList.remove('cue'); off.classList.remove('dim') }, 5200)
  }
  switch (name) {
    case 'options':
      if (currentView !== 'choose') goto('choose')
      break
    case 'web':
      if (currentView === 'choose') focus(web, desk)
      break
    case 'desktop':
      if (currentView === 'choose') focus(desk, web)
      break
    case 'recommend':
      if (currentView !== 'choose') goto('choose')
      focus(desk, web)
      restart(desk.querySelector('[data-mode]'), 'pulse')
      break
    case 'dashboard':
      if (currentView === 'web') restart($('open-dashboard'), 'pulse')
      break
    case 'install':
      if (currentView === 'desktop') document.querySelector('.install')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      break
    case 'download':
      if (currentView === 'desktop') {
        $('download-btn').scrollIntoView({ behavior: 'smooth', block: 'center' })
        restart($('download-btn'), 'pulse')
      }
      break
  }
}

/** Client tools the ElevenLabs agent can call. The returned text tells the agent what is on screen now. */
function tool(name, arg) {
  if (name === 'options') {
    goto('choose')
    return 'The two options are on screen: the web app on the left, and the desktop app, recommended, on the right.'
  }
  if (name === 'highlight_download') {
    if (currentView === 'desktop') { cue('download'); return 'The Download for Windows button is highlighted.' }
    cue('recommend')
    return 'The desktop app option is highlighted with its Get the desktop app button.'
  }
  if (name === 'open_mode') {
    if (arg !== 'web' && arg !== 'desktop') return 'Unknown mode. Use "web" or "desktop".'
    goto(arg)
    return arg === 'web' ? 'The web app overview is on screen, with an Open the dashboard button.' : 'The desktop app page is on screen, with the Download for Windows button.'
  }
  return 'Unknown tool.'
}

let captionTimer = 0
const voice = createVoice({
  state(s) {
    const live = s !== 'idle'
    $('voice-dock').classList.toggle('live', live)
    $('voice-dock-text').textContent = !live ? 'Ask the ghost' : s === 'connecting' ? 'Connecting…' : s === 'speaking' ? 'The ghost is talking · tap to stop' : 'Listening · tap to end'
    clearTimeout(captionTimer)
    if (!live) captionTimer = setTimeout(() => { $('dock-caption').hidden = true }, 3500)
  },
  level(v) { $('voice-dock-ghost').style.setProperty('--level', v.toFixed(3)) },
  caption(who, text) {
    if (!VOICE_VIEWS.includes(currentView)) return
    clearTimeout(captionTimer)
    const p = $('dock-caption-text')
    p.textContent = who === 'you' ? `You: ${text}` : text
    p.classList.toggle('you', who === 'you')
    $('dock-caption').hidden = false
  },
  clearCaptions() { $('dock-caption').hidden = true },
  previewNote(on) { $('preview-note').hidden = !on },
  error(text) { toast(text) },
  cue,
  tool,
})

/** Which browser-voice script fits the step on screen. */
const scriptFor = (view) => (view === 'web' || view === 'dashboard' ? 'web' : view === 'desktop' ? 'desktop' : 'intro')

// ------------------------------------------------------------------ recording

function elapsed() {
  if (!rec) return 0
  return ((rec.paused ? rec.pausedAt : Date.now()) - rec.startedAt - rec.pausedTotal) / 1000
}

/** A 1 s clock from a worker: page timers are throttled while you work in the shared window. */
function startTicker(fn) {
  try {
    const url = URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 1000)'], { type: 'text/javascript' }))
    const worker = new Worker(url)
    worker.onmessage = fn
    return () => { worker.terminate(); URL.revokeObjectURL(url) }
  } catch {
    const id = setInterval(fn, 1000)
    return () => clearInterval(id)
  }
}

const smallCanvas = document.createElement('canvas')
smallCanvas.width = DIFF_W
smallCanvas.height = DIFF_H
const smallCtx = smallCanvas.getContext('2d', { willReadFrequently: true })
const shotCanvas = document.createElement('canvas')

async function grabFrame() {
  if (rec.capture) {
    try {
      const bitmap = await rec.capture.grabFrame()
      return { source: bitmap, w: bitmap.width, h: bitmap.height, done: () => bitmap.close() }
    } catch {
      // Fall back to the preview video below.
    }
  }
  const video = $('preview')
  if (video.videoWidth) return { source: video, w: video.videoWidth, h: video.videoHeight, done() {} }
  return null
}

function thumbnail(source) {
  smallCtx.drawImage(source, 0, 0, DIFF_W, DIFF_H)
  const { data } = smallCtx.getImageData(0, 0, DIFF_W, DIFF_H)
  const gray = new Uint8Array(DIFF_W * DIFF_H)
  for (let i = 0; i < gray.length; i++) gray[i] = (data[i * 4] * 3 + data[i * 4 + 1] * 6 + data[i * 4 + 2]) / 10
  return gray
}

function changedShare(a, b) {
  let changed = 0
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > PIXEL_DELTA) changed++
  return changed / a.length
}

/** Keep a screenshot if the screen changed since the last one (or always, when asked for). */
async function shoot(force) {
  if (!rec || rec.grabbing) return
  if (rec.steps.length >= MAX_SHOTS) {
    if (force) toast(`That's ${MAX_SHOTS} screenshots, the most one recording keeps.`)
    return
  }
  rec.grabbing = true
  try {
    const frame = await grabFrame()
    if (!frame || !rec) return
    try {
      const small = thumbnail(frame.source)
      if (!force && rec.lastSmall && changedShare(small, rec.lastSmall) < CHANGE_FRACTION) return
      rec.lastSmall = small
      const scale = Math.min(1, SHOT_MAX_W / frame.w)
      shotCanvas.width = Math.round(frame.w * scale)
      shotCanvas.height = Math.round(frame.h * scale)
      shotCanvas.getContext('2d').drawImage(frame.source, 0, 0, shotCanvas.width, shotCanvas.height)
      const t = elapsed()
      rec.lastShotT = t
      const step = { id: uid(), t, image: shotCanvas.toDataURL('image/jpeg', 0.82), title: '', note: '' }
      rec.steps.push(step)
      $('stat-shots').textContent = rec.steps.length
      const thumb = el('button', { type: 'button', className: 'strip-item', title: `Screenshot at ${fmt(t)}` },
        el('img', { src: step.image, alt: `Screenshot at ${fmt(t)}` }), el('span', {}, fmt(t)))
      thumb.addEventListener('click', () => openLightbox(step.image))
      $('live-strip').append(thumb)
      thumb.scrollIntoView({ block: 'nearest', inline: 'end' })
      if (force) toast('Screenshot added.')
    } finally {
      frame.done()
    }
  } finally {
    if (rec) rec.grabbing = false
  }
}

function tick() {
  if (!rec || rec.stopping) return
  const t = elapsed()
  $('rec-timer').textContent = fmt(t)
  if (rec.paused) return
  const left = Math.max(0, Math.ceil(INTRO_S - t))
  $('intro-count').textContent = left
  $('intro-fill').style.strokeDashoffset = String(119.4 * (left / INTRO_S))
  if (t < INTRO_S) return
  $('intro-card').hidden = true
  if (t - rec.lastShotT >= rec.interval) void shoot(false)
}

function addLine(text) {
  if (!rec) return
  // A final result arrives when the sentence ends; date it from roughly when it started.
  const t = Math.max(0, elapsed() - countWords(text) * 0.35)
  rec.lines.push({ t, text })
  rec.words += countWords(text)
  $('stat-words').textContent = rec.words
  const box = $('live-transcript')
  box.querySelector('.muted')?.remove()
  box.querySelector('.interim')?.remove()
  box.append(el('p', {}, el('span', { className: 'line-time' }, fmt(t)), text))
  box.scrollTop = box.scrollHeight
}

function showInterim(text) {
  const box = $('live-transcript')
  let p = box.querySelector('.interim')
  if (!text) { p?.remove(); return }
  if (!p) {
    box.querySelector('.muted')?.remove()
    p = el('p', { className: 'interim' })
    box.append(p)
  }
  p.textContent = text
  box.scrollTop = box.scrollHeight
}

function startSpeech() {
  if (!SpeechRecognition || !options.transcript) return
  const r = new SpeechRecognition()
  r.continuous = true
  r.interimResults = true
  r.lang = navigator.language || 'en-US'
  r.onresult = (event) => {
    let interim = ''
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i]
      const text = result[0].transcript.trim()
      if (result.isFinal) { if (text) addLine(text) } else interim += `${text} `
    }
    showInterim(interim.trim())
  }
  r.onerror = (event) => {
    if (!rec || !['not-allowed', 'service-not-allowed', 'audio-capture'].includes(event.error)) return
    rec.speechOff = true
    $('mic-status').textContent = event.error === 'audio-capture'
      ? 'No microphone found for speech-to-text.'
      : 'The browser blocked speech-to-text. The video still has your voice.'
  }
  // Chrome ends recognition after a silence; keep it going while recording.
  r.onend = () => {
    if (rec && rec.speech === r && !rec.paused && !rec.stopping && !rec.speechOff) {
      try { r.start() } catch { /* already starting */ }
    }
  }
  rec.speech = r
  try { r.start() } catch { /* ignore */ }
}

function startRecorder(screen, mic) {
  if (!options.video || !('MediaRecorder' in window)) return
  const stream = new MediaStream([...screen.getVideoTracks(), ...(mic ? mic.getAudioTracks() : [])])
  const types = mic
    ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']
    : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4']
  const mimeType = types.find((type) => MediaRecorder.isTypeSupported(type))
  try {
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: 2_500_000 } : undefined)
    recorder.ondataavailable = (event) => { if (event.data.size) rec?.chunks.push(event.data) }
    recorder.start(1000)
    rec.recorder = recorder
  } catch {
    toast("This browser can't save a video. Screenshots and your words are still kept.")
  }
}

function stopRecorder() {
  const recorder = rec?.recorder
  if (!recorder || recorder.state === 'inactive') return Promise.resolve(null)
  return new Promise((resolve) => {
    recorder.onstop = () => resolve(rec.chunks.length ? new Blob(rec.chunks, { type: recorder.mimeType || 'video/webm' }) : null)
    recorder.stop()
  })
}

/** One click: pick a window, and recording starts. Called straight from a click so the browser allows sharing. */
async function startRecording() {
  if (rec) return
  if (!canShare) {
    toast('Recording needs Chrome or Edge on a computer.')
    return
  }
  void voice.stop()
  let screen
  try {
    screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false })
  } catch (failure) {
    toast(failure?.name === 'NotAllowedError' ? 'Sharing was cancelled. Choose a window to start recording.' : `The screen couldn't be shared: ${failure?.message || failure}`)
    return
  }
  let mic = null
  if (options.mic) {
    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
    } catch {
      toast('No microphone: recording without your voice.')
    }
  }
  const track = screen.getVideoTracks()[0]
  rec = {
    interval: options.interval,
    startedAt: Date.now(),
    pausedTotal: 0,
    pausedAt: 0,
    paused: false,
    stopping: false,
    grabbing: false,
    lastShotT: -Infinity,
    lastSmall: null,
    steps: [],
    lines: [],
    words: 0,
    chunks: [],
    screen,
    mic,
    capture: 'ImageCapture' in window ? new ImageCapture(track) : null,
    recorder: null,
    speech: null,
    speechOff: false,
    stopTicker: null,
  }
  track.addEventListener('ended', () => void stop()) // "Stop sharing" in the browser bar
  const surface = track.getSettings?.().displaySurface
  $('share-label').textContent = surface === 'monitor' ? 'Sharing your screen' : surface === 'browser' ? 'Sharing a tab' : surface === 'window' ? 'Sharing a window' : ''
  const preview = $('preview')
  preview.srcObject = screen
  void preview.play().catch(() => undefined)
  $('live-strip').replaceChildren()
  $('live-transcript').replaceChildren(el('p', { className: 'muted' }, SpeechRecognition && options.transcript ? 'Your words appear here as you speak.' : 'Speech-to-text is off.'))
  $('stat-shots').textContent = '0'
  $('stat-words').textContent = '0'
  $('mic-status').textContent = options.mic && !mic ? 'Recording without a microphone.' : ''
  $('intro-card').hidden = false
  setPaused(false)
  startRecorder(screen, mic)
  startSpeech()
  rec.stopTicker = startTicker(tick)
  goto('live')
  tick()
}

function setPaused(paused) {
  $('rec-label').textContent = paused ? 'Paused' : 'Recording'
  $('rec-dot').classList.toggle('paused', paused)
  $('pause-label').textContent = paused ? 'Resume' : 'Pause'
  $('pause-icon').setAttribute('href', paused ? '#i-play' : '#i-pause')
}

function togglePause() {
  if (!rec || rec.stopping) return
  if (!rec.paused) {
    rec.paused = true
    rec.pausedAt = Date.now()
    if (rec.recorder?.state === 'recording') rec.recorder.pause()
    try { rec.speech?.stop() } catch { /* ignore */ }
  } else {
    rec.pausedTotal += Date.now() - rec.pausedAt
    rec.paused = false
    if (rec.recorder?.state === 'paused') rec.recorder.resume()
    if (rec.speech && !rec.speechOff) { try { rec.speech.start() } catch { /* ignore */ } }
  }
  setPaused(rec.paused)
}

function autoTitle(note, n) {
  const sentence = note.split(/(?<=[.!?])\s/)[0].trim()
  if (!sentence) return `Step ${n}`
  const short = sentence.split(/\s+/).slice(0, 9).join(' ')
  return (short.length < sentence.length ? `${short}…` : short).replace(/^./, (c) => c.toUpperCase())
}

/** The guide's name, from the introduction ("Today I'll show you how to post an invoice" → "How to post an invoice"), or the date. */
function guideTitle(intro) {
  let first = intro.split(/(?<=[.!?])\s/)[0].trim().replace(/[.!?]+$/, '')
  first = first.replace(/^((so|okay|ok|alright|right|now|today|hi|hello|hey)[,\s]+)+/i, '')
  const shown = first.match(/\b(?:i'?m going to|i am going to|i will|i'll|let me|we'?re going to|we will|we'll)\s+(?:show|walk|take)\s+(?:you\s+)?(?:through\s+)?(.+)$/i)
  if (shown) first = shown[1]
  first = first.trim()
  if (first.length < 8) return `Recording, ${shortDate(Date.now())}`
  const title = first.length > 72 ? `${first.slice(0, 70).trim()}…` : first
  return title.replace(/^./, (c) => c.toUpperCase())
}

/** Turn screenshots and narration into a guide: what was said before the first screenshot is the introduction. */
function buildGuide(r, duration) {
  const steps = r.steps.slice()
  const cut = Math.min(INTRO_S + 2, steps[0]?.t ?? Infinity)
  const intro = r.lines.filter((l) => l.t < cut).map((l) => l.text).join(' ')
  const rest = r.lines.filter((l) => l.t >= cut)
  steps.forEach((step, i) => {
    const from = i === 0 ? -Infinity : step.t
    const to = steps[i + 1]?.t ?? Infinity
    step.note = rest.filter((l) => l.t >= from && l.t < to).map((l) => l.text).join(' ')
    step.title = autoTitle(step.note, i + 1)
  })
  return { id: uid(), title: guideTitle(intro), intro, created: Date.now(), duration, hasVideo: false, steps }
}

async function stop() {
  if (!rec || rec.stopping) return
  if (rec.paused) togglePause()
  // The screen as it was at the end, if it changed since the last screenshot.
  if (elapsed() >= 1) await shoot(false)
  rec.stopping = true
  rec.stopTicker?.()
  try { rec.speech?.stop() } catch { /* ignore */ }
  const duration = elapsed()
  const blob = await stopRecorder()
  for (const track of [...rec.screen.getTracks(), ...(rec.mic?.getTracks() ?? [])]) track.stop()
  $('preview').srcObject = null
  const next = buildGuide(rec, duration)
  next.hasVideo = !!blob
  rec = null
  guide = next
  videoBlob = blob
  if (!next.steps.length) toast('No screenshots were taken. Record a little longer, or press Screenshot.')
  await saveRecording(next, blob)
  goto(`guide/${next.id}`)
}

// ------------------------------------------------------------------ dashboard

function renderDashboard() {
  const list = $('recordings')
  $('dash-empty').hidden = recordings.length > 0
  list.replaceChildren(...recordings.map((r, i) => {
    const remove = el('button', { type: 'button', className: 'icon-btn danger', title: 'Delete recording' })
    remove.setAttribute('aria-label', `Delete ${r.title}`)
    remove.append(icon('trash'))
    remove.addEventListener('click', async (event) => {
      event.preventDefault()
      event.stopPropagation()
      if (!window.confirm(`Delete "${r.title}"? This can't be undone.`)) return
      await deleteRecording(r.id)
      renderDashboard()
      toast('Recording deleted.')
    })
    const card = el('div', { className: 'rec-card' },
      el('a', { className: 'rec-open', href: `#/guide/${encodeURIComponent(r.id)}` },
        el('span', { className: 'core' },
          r.thumb ? el('img', { className: 'rec-thumb', src: r.thumb, alt: '', loading: 'lazy' }) : el('span', { className: 'rec-thumb no-image' }, 'No screenshot'),
          el('h3', {}, r.title),
          el('span', { className: 'rec-meta' }, `${r.count} step${r.count === 1 ? '' : 's'} · ${fmt(r.duration)} · ${shortDate(r.created)}`))),
      remove)
    card.style.animationDelay = `${Math.min(i, 8) * 60}ms`
    return card
  }))
}

// ------------------------------------------------------------------ guide

function openLightbox(src) {
  $('lightbox-img').src = src
  $('lightbox').showModal()
}

function move(index, by) {
  const to = index + by
  if (to < 0 || to >= guide.steps.length) return
  const [step] = guide.steps.splice(index, 1)
  guide.steps.splice(to, 0, step)
  saveSoon()
  renderGuide()
}

function removeStep(index) {
  const [step] = guide.steps.splice(index, 1)
  idb('readwrite', (s) => s.delete(`img:${guide.id}:${step.id}`)).catch(() => undefined)
  saveSoon()
  renderGuide()
  toast(`Step ${index + 1} deleted.`)
}

function stepCard(step, index) {
  const n = index + 1
  const title = el('input', { className: 'step-title', value: step.title, maxLength: 140, placeholder: `Step ${n}` })
  title.setAttribute('aria-label', `Title of step ${n}`)
  title.addEventListener('input', () => { step.title = title.value; saveSoon() })
  const note = el('textarea', { value: step.note, rows: 2, placeholder: 'What happens here, and why. What do you check before moving on?' })
  note.setAttribute('aria-label', `Notes for step ${n}`)
  note.addEventListener('input', () => { step.note = note.value; autoGrow(note); saveSoon() })
  requestAnimationFrame(() => autoGrow(note))
  const toolButton = (label, name, onClick, disabled = false, extra = '') => {
    const b = el('button', { type: 'button', className: `icon-btn ${extra}`, title: label, disabled })
    b.setAttribute('aria-label', label)
    b.append(icon(name))
    b.addEventListener('click', onClick)
    return b
  }
  const shot = el('button', { type: 'button', className: 'step-shot', title: 'Enlarge' },
    step.image ? el('img', { src: step.image, alt: `Screenshot for step ${n}`, loading: 'lazy' }) : el('div', { className: 'no-image' }, 'No screenshot'))
  if (step.image) shot.addEventListener('click', () => openLightbox(step.image))
  else shot.disabled = true
  return el('li', { className: 'bezel step' },
    el('div', { className: 'core' },
      shot,
      el('div', { className: 'step-body' },
        el('div', { className: 'step-top' },
          el('span', { className: 'step-badge' }, String(n)),
          el('span', { className: 'step-time' }, fmt(step.t)),
          el('span', { className: 'step-tools' },
            toolButton('Move up', 'arrow-up', () => move(index, -1), index === 0),
            toolButton('Move down', 'arrow-down', () => move(index, 1), index === guide.steps.length - 1),
            toolButton('Delete step', 'trash', () => removeStep(index), false, 'danger'))),
        title,
        note)))
}

function renderGuide() {
  $('guide-empty').hidden = true
  $('guide-body').hidden = false
  $('guide-title').textContent = guide.title
  $('guide-meta').textContent = [`${guide.steps.length} step${guide.steps.length === 1 ? '' : 's'}`, fmt(guide.duration), shortDate(guide.created)].join(' · ')
  const intro = $('guide-intro')
  intro.value = guide.intro
  requestAnimationFrame(() => autoGrow(intro))
  const list = $('guide-steps')
  list.replaceChildren(...guide.steps.map(stepCard))
  if (!guide.steps.length) list.append(el('li', { className: 'bezel empty-steps' }, el('div', { className: 'core' }, 'No screenshots in this recording. The screen may not have changed, or it ended during the introduction.')))
  if (videoUrl) URL.revokeObjectURL(videoUrl)
  videoUrl = videoBlob ? URL.createObjectURL(videoBlob) : ''
  $('export-video').hidden = !videoBlob
  $('video-card').hidden = !videoBlob
  const video = $('guide-video')
  if (videoBlob) video.src = videoUrl
  else video.removeAttribute('src')
}

function exportHtml() {
  if (!guide) return
  const para = (text) => (text ? `<p>${esc(text).replace(/\n/g, '<br>')}</p>` : '')
  const steps = guide.steps.map((s, i) => `
  <section class="step">
    <h2><span>${i + 1}</span>${esc(s.title || `Step ${i + 1}`)}</h2>
    ${para(s.note)}
    ${s.image ? `<img src="${s.image}" alt="Screenshot for step ${i + 1}">` : ''}
  </section>`).join('')
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(guide.title)}</title>
<style>
  body{margin:0;background:#f6f5fa;color:#16151c;font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
  main{max-width:880px;margin:0 auto;padding:56px 22px 96px}
  .meta{display:inline-block;padding:5px 12px;border-radius:99px;background:#ece8fa;color:#5b47c7;font-size:11px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;margin:0}
  h1{font-size:40px;line-height:1.05;letter-spacing:-.03em;font-weight:600;margin:14px 0 18px}
  .intro{background:#fff;border-radius:20px;padding:18px 22px;margin:0 0 28px;box-shadow:0 0 0 1px #e8e5f0}
  .intro p{margin:0;color:#45434f}
  .step{background:#fff;border-radius:22px;padding:22px;margin:0 0 18px;box-shadow:0 0 0 1px #e8e5f0,0 20px 40px -30px rgba(80,60,160,.35);break-inside:avoid}
  .step h2{display:flex;gap:12px;align-items:center;font-size:20px;font-weight:600;letter-spacing:-.01em;margin:0 0 8px}
  .step h2 span{display:inline-grid;place-items:center;min-width:30px;height:30px;border-radius:50%;background:linear-gradient(120deg,#7cc7f4,#b38de8 55%,#f59fdf);color:#fff;font-size:14px}
  .step p{margin:0 0 14px;color:#45434f}
  .step img{display:block;width:100%;border-radius:14px;box-shadow:0 0 0 1px #e8e5f0}
  footer{color:#8b8898;font-size:13px;margin-top:36px}
</style></head>
<body><main>
  <p class="meta">Step-by-step guide</p>
  <h1>${esc(guide.title)}</h1>
  ${guide.intro ? `<div class="intro">${para(guide.intro)}</div>` : ''}
  ${steps}
  <footer>Recorded with Apprentice on ${esc(new Date(guide.created).toLocaleDateString())}.</footer>
</main></body></html>`
  download(new Blob([html], { type: 'text/html' }), `${slug(guide.title)}.html`)
}

// ------------------------------------------------------------------ wiring

function loadOptions() {
  const saved = store.get('apprentice-options')
  options = { ...DEFAULT_OPTIONS, ...(saved && typeof saved === 'object' ? saved : {}) }
  if (!SpeechRecognition) options.transcript = false
  $('o-mic').checked = options.mic
  $('o-transcript').checked = options.transcript
  $('o-video').checked = options.video
  for (const radio of document.querySelectorAll('input[name="o-interval"]')) radio.checked = Number(radio.value) === options.interval
}

function readOptions() {
  const interval = Number(document.querySelector('input[name="o-interval"]:checked')?.value) || 5
  options = { mic: $('o-mic').checked, transcript: $('o-transcript').checked, video: $('o-video').checked, interval }
  store.set('apprentice-options', options)
}

function init() {
  document.documentElement.classList.remove('no-js')
  // The HTML already links to the zip, so the button works without JavaScript; config.js can point it elsewhere.
  for (const a of document.querySelectorAll('[data-download]')) {
    a.href = config.downloadUrl
    if (/\.(zip|exe|msi)$/i.test(config.downloadUrl) && !/^https?:/i.test(config.downloadUrl)) a.setAttribute('download', '')
    else { a.removeAttribute('download'); a.target = '_blank'; a.rel = 'noopener' }
  }
  for (const a of document.querySelectorAll('[data-github]')) a.href = config.githubUrl

  if (!SpeechRecognition) {
    $('o-transcript').disabled = true
    $('o-transcript-hint').textContent = 'Not available in this browser. Chrome and Edge can do it.'
  }
  if (!canShare) $('no-share').hidden = false
  loadOptions()

  $('kickstart').addEventListener('click', () => {
    goto('choose')
    void voice.kickstart()
  })
  for (const button of document.querySelectorAll('[data-mode]')) {
    button.addEventListener('click', () => {
      goto(button.dataset.mode)
      voice.narrate(button.dataset.mode)
    })
  }
  for (const button of document.querySelectorAll('[data-start]')) button.addEventListener('click', () => void startRecording())
  $('open-options').addEventListener('click', () => $('options').showModal())
  $('options-start').addEventListener('click', (event) => {
    event.preventDefault()
    readOptions()
    $('options').close()
    void startRecording()
  })
  $('options').addEventListener('close', readOptions)
  $('voice-dock').addEventListener('click', () => void voice.toggle(scriptFor(currentView)))
  $('burger').addEventListener('click', () => setMenu($('burger').getAttribute('aria-expanded') !== 'true'))
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') setMenu(false) })

  $('shot-btn').addEventListener('click', () => void shoot(true))
  $('pause-btn').addEventListener('click', togglePause)
  $('stop-btn').addEventListener('click', () => void stop())
  $('guide-title').addEventListener('input', (e) => { if (guide) { guide.title = e.target.textContent.trim() || 'Untitled guide'; saveSoon() } })
  $('guide-title').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur() } })
  $('guide-intro').addEventListener('input', (e) => { if (guide) { guide.intro = e.target.value; autoGrow(e.target); saveSoon() } })
  $('export-html').addEventListener('click', exportHtml)
  $('export-pdf').addEventListener('click', () => window.print())
  $('export-video').addEventListener('click', () => {
    if (videoBlob) download(videoBlob, `${slug(guide?.title ?? 'recording')}.${videoBlob.type.includes('mp4') ? 'mp4' : 'webm'}`)
  })
  $('delete-recording').addEventListener('click', async () => {
    if (!guide || !window.confirm(`Delete "${guide.title}"? This can't be undone.`)) return
    await deleteRecording(guide.id)
    toast('Recording deleted.')
    goto('dashboard')
  })
  $('lightbox').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close() })
  window.addEventListener('beforeunload', (e) => { if (rec) { e.preventDefault(); e.returnValue = '' } })
  window.addEventListener('popstate', () => void route())
  window.addEventListener('hashchange', () => void route())
  void loadIndex().then(() => route())
}

init()
