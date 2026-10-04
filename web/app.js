// Apprentice website and web recorder. A browser only sees the pixels of the screen you share, so the recorder
// keeps a screenshot whenever the screen changes, writes down what you say, and turns that into a step guide.
// Field names, typed values, masking and 24/7 learning need the desktop app; the page says so and links to it.
// Recordings stay in this browser (IndexedDB). Nothing is uploaded.
import config from './config.js'
import { createVoice } from './voice.js'

/** The expert introduces the task first; screenshots start after this many seconds. */
const INTRO_S = 10
const MAX_SHOTS = 300
const SHOT_MAX_W = 1600
const DIFF_W = 64
const DIFF_H = 36
/** A screenshot is kept when this share of a 64×36 thumbnail changed by more than PIXEL_DELTA. */
const CHANGE_FRACTION = 0.008
const PIXEL_DELTA = 22
const DEFAULT_OPTIONS = { mic: true, transcript: true, video: true, interval: 5 }

const $ = (id) => document.getElementById(id)
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
const canShare = !!navigator.mediaDevices?.getDisplayMedia

/** The recording in progress, or null. */
let rec = null
/** The last guide: { id, title, intro, created, duration, hasVideo, steps: [{ id, t, image, title, note }] } */
let guide = null
let videoBlob = null
let videoUrl = ''
let options = { ...DEFAULT_OPTIONS }

// ------------------------------------------------------------------ helpers

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
const uid = () => Math.random().toString(36).slice(2, 10)
const countWords = (text) => text.split(/\s+/).filter(Boolean).length
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'guide'
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

// ------------------------------------------------------------------ storage (IndexedDB, best effort)

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

let saveTimer = 0
function saveSoon() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    if (guide) idb('readwrite', (s) => s.put(docOnly(guide), 'guide')).catch(() => undefined)
  }, 400)
}

async function saveNew(g, blob) {
  try {
    await idb('readwrite', (s) => {
      s.clear()
      s.put(docOnly(g), 'guide')
      for (const st of g.steps) s.put(st.image, `img:${st.id}`)
      if (blob) s.put(blob, 'video')
    })
  } catch {
    toast("This browser couldn't keep the recording. Download the guide before you close the tab.")
  }
}

async function loadSaved() {
  try {
    const doc = await idbGet('guide')
    if (!doc?.steps) return
    for (const st of doc.steps) st.image = (await idbGet(`img:${st.id}`)) ?? ''
    guide = doc
    videoBlob = (await idbGet('video')) ?? null
  } catch {
    // Private windows can refuse IndexedDB: the page still works for this visit.
  }
}

// ------------------------------------------------------------------ routing and page behaviour

const VIEWS = ['home', 'live', 'guide']
let currentView = ''

function viewFromHash() {
  const hash = location.hash
  if (hash.startsWith('#/')) {
    const name = hash.slice(2).split('?')[0]
    return VIEWS.includes(name) ? name : 'home'
  }
  return 'home'
}

function route() {
  let name = viewFromHash()
  if (rec) name = 'live' // while recording, the live view is the only place to be
  else if (name === 'live') name = guide ? 'guide' : 'home'
  const changed = name !== currentView
  currentView = name
  for (const section of document.querySelectorAll('[data-view]')) section.hidden = section.dataset.view !== name
  document.body.classList.toggle('is-live', name === 'live')
  $('island').hidden = name === 'live'
  updateDock()
  if (name === 'guide') renderGuide()
  if (changed) {
    const anchor = !location.hash.startsWith('#/') && location.hash.length > 1 ? document.getElementById(location.hash.slice(1)) : null
    if (anchor) requestAnimationFrame(() => anchor.scrollIntoView({ behavior: 'instant', block: 'start' }))
    else window.scrollTo({ top: 0, behavior: 'instant' })
    observeReveals()
  }
}

function goHome(sectionId) {
  if (currentView !== 'home') {
    history.pushState(null, '', '#/')
    route()
  }
  if (sectionId) requestAnimationFrame(() => document.getElementById(sectionId)?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
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
    if (!revealer || node.closest('[hidden]')) { if (!revealer) node.classList.add('in'); continue }
    revealer.observe(node)
  }
}

function setMenu(open) {
  const menu = $('menu')
  $('burger').setAttribute('aria-expanded', String(open))
  $('burger').setAttribute('aria-label', open ? 'Close menu' : 'Open menu')
  if (open) {
    menu.hidden = false
    requestAnimationFrame(() => requestAnimationFrame(() => menu.classList.add('open')))
  } else {
    menu.classList.remove('open')
    setTimeout(() => { if (!menu.classList.contains('open')) menu.hidden = true }, 350)
  }
}

// ------------------------------------------------------------------ voice agent ("Ask the ghost")

const SECTIONS = { how: 'how', desktop: 'desktop', compare: 'compare', comparison: 'compare', teach: 'teach', privacy: 'privacy', download: 'download', ask: 'ask' }
let askVisible = false

function spotlight(node) {
  node.classList.remove('spotlight')
  void node.offsetWidth
  node.classList.add('spotlight')
  setTimeout(() => node.classList.remove('spotlight'), 2700)
}

const voice = createVoice({
  state(s) {
    const live = s !== 'idle'
    const labels = { idle: 'Ready when you are', connecting: 'Connecting…', listening: 'Listening', speaking: 'Speaking' }
    $('orb-state').textContent = labels[s] ?? s
    $('orb-state').classList.toggle('live', live)
    for (const label of document.querySelectorAll('[data-talk-label]')) label.textContent = live ? 'End the conversation' : 'Talk to the ghost'
    $('voice-dock').classList.toggle('live', live)
    $('voice-dock-text').textContent = live ? (s === 'speaking' ? 'The ghost is talking' : s === 'connecting' ? 'Connecting…' : 'Listening… tap to end') : 'Ask the ghost'
    if (!live) $('dock-caption').hidden = true
  },
  level(v) { $('orb').style.setProperty('--level', v.toFixed(3)) },
  caption(who, text) {
    const box = $('captions')
    box.querySelector('.muted')?.remove()
    box.append(el('p', { className: who === 'you' ? 'you' : '' }, text))
    while (box.children.length > 4) box.firstElementChild.remove()
    if (who !== 'you' && !askVisible && currentView === 'home') {
      $('dock-caption').textContent = text
      $('dock-caption').hidden = false
    }
  },
  clearCaptions() { $('captions').replaceChildren() },
  show(section, pulse = false) {
    const id = SECTIONS[section.toLowerCase()]
    const node = id && document.getElementById(id)
    if (!node) return `There is no section called "${section}". Use one of: how, desktop, compare, teach, privacy, download.`
    goHome()
    node.scrollIntoView({ behavior: 'smooth', block: id === 'compare' || id === 'teach' || id === 'privacy' ? 'center' : 'start' })
    const target = node.classList.contains('bezel') ? node : node.querySelector('.bezel') ?? node
    spotlight(target)
    if (pulse || id === 'download') {
      const btn = $('download-btn')
      btn.classList.remove('pulse')
      void btn.offsetWidth
      btn.classList.add('pulse')
    }
    return id === 'download' ? 'The Download for Windows button is highlighted on screen.' : `Showing the ${id} section on screen.`
  },
  error(text) { toast(text) },
  previewNote(on) { $('preview-note').hidden = !on },
})

function updateDock() {
  $('voice-dock').classList.toggle('away', currentView !== 'home' || askVisible)
}

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
  if (voice.active) void voice.stop()
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
  history.pushState(null, '', '#/live')
  route()
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
  if (first.length < 8) return `Recording, ${new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`
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
  await saveNew(next, blob)
  history.pushState(null, '', '#/guide')
  route()
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

function remove(index) {
  const [step] = guide.steps.splice(index, 1)
  idb('readwrite', (s) => s.delete(`img:${step.id}`)).catch(() => undefined)
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
  const tool = (label, name, onClick, disabled = false, extra = '') => {
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
            tool('Move up', 'arrow-up', () => move(index, -1), index === 0),
            tool('Move down', 'arrow-down', () => move(index, 1), index === guide.steps.length - 1),
            tool('Delete step', 'trash', () => remove(index), false, 'danger'))),
        title,
        note)))
}

function renderGuide() {
  const has = !!guide
  $('guide-empty').hidden = has
  $('guide-body').hidden = !has
  for (const link of document.querySelectorAll('[data-guide-link]')) link.hidden = !has
  if (!has) return
  $('guide-title').textContent = guide.title
  const meta = [`${guide.steps.length} step${guide.steps.length === 1 ? '' : 's'}`, fmt(guide.duration), new Date(guide.created).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })]
  $('guide-meta').textContent = meta.join(' · ')
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

  for (const button of document.querySelectorAll('[data-start]')) button.addEventListener('click', () => { setMenu(false); void startRecording() })
  $('open-options').addEventListener('click', () => $('options').showModal())
  $('options-start').addEventListener('click', (event) => {
    event.preventDefault()
    readOptions()
    $('options').close()
    void startRecording()
  })
  $('options').addEventListener('close', readOptions)

  for (const link of document.querySelectorAll('[data-scroll]')) {
    link.addEventListener('click', (event) => {
      event.preventDefault()
      setMenu(false)
      goHome(link.getAttribute('href').slice(1))
    })
  }
  for (const link of document.querySelectorAll('[data-goto]')) {
    link.addEventListener('click', (event) => { event.preventDefault(); goHome(link.dataset.goto) })
  }
  $('burger').addEventListener('click', () => setMenu($('burger').getAttribute('aria-expanded') !== 'true'))
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') setMenu(false) })

  for (const button of document.querySelectorAll('[data-talk]')) button.addEventListener('click', () => void voice.toggle())
  if (revealer) {
    new IntersectionObserver(([entry]) => { askVisible = entry.isIntersecting; if (askVisible) $('dock-caption').hidden = true; updateDock() }, { threshold: 0.35 }).observe($('ask'))
  }

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
  $('lightbox').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close() })
  window.addEventListener('beforeunload', (e) => { if (rec) { e.preventDefault(); e.returnValue = '' } })
  window.addEventListener('popstate', route)
  window.addEventListener('hashchange', route)
  route()
  void loadSaved().then(() => {
    for (const link of document.querySelectorAll('[data-guide-link]')) link.hidden = !guide
    if (currentView === 'guide') renderGuide()
  })
}

init()
