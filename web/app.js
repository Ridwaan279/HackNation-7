// Apprentice web recorder. A browser can only see the pixels of the screen you share, so this records the
// screen, keeps a screenshot whenever it changes, writes down what you say, and turns that into a step guide.
// Field names, typed values, masking and 24/7 learning need the desktop app (the banner says so).
// Everything is kept in this browser (IndexedDB); nothing is uploaded.

/** Where "Download the app" goes. Point it at a release (.exe) once one is published. */
const DOWNLOAD_URL = 'https://github.com/Ridwaan279/HackNation-7#readme'
/** The expert introduces the task first; screenshots start after this many seconds. */
const INTRO_S = 10
const MAX_SHOTS = 300
const SHOT_MAX_W = 1600
const DIFF_W = 64
const DIFF_H = 36
/** A screenshot is kept when this share of a 64×36 thumbnail changed by more than PIXEL_DELTA. */
const CHANGE_FRACTION = 0.008
const PIXEL_DELTA = 22

const $ = (id) => document.getElementById(id)
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
const canShare = !!navigator.mediaDevices?.getDisplayMedia

/** The recording in progress, or null. */
let rec = null
/** The last guide: { id, title, role, intro, created, duration, hasVideo, steps: [{ id, t, image, title, note }] } */
let guide = null
let videoBlob = null
let videoUrl = ''

// ------------------------------------------------------------------ helpers

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
const uid = () => Math.random().toString(36).slice(2, 10)
const words = (text) => text.split(/\s+/).filter(Boolean).length
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'guide'

function toast(text) {
  const el = $('toast')
  el.textContent = text
  el.hidden = false
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => { el.hidden = true }, 4000)
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
    toast("This browser couldn't keep the recording (storage full?). Download the guide before you close the tab.")
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

// ------------------------------------------------------------------ routing

const VIEWS = ['home', 'record', 'live', 'review', 'desktop']

function route() {
  let name = location.hash.replace(/^#\/?/, '').split('?')[0] || 'home'
  if (!VIEWS.includes(name)) name = 'home'
  if (rec) name = 'live' // while recording, the live view is the only place to be
  else if (name === 'live') name = 'record'
  for (const section of document.querySelectorAll('[data-view]')) section.hidden = section.dataset.view !== name
  for (const a of document.querySelectorAll('[data-nav]')) {
    const current = a.dataset.nav === name || (a.dataset.nav === 'record' && name === 'live')
    if (current) a.setAttribute('aria-current', 'page')
    else a.removeAttribute('aria-current')
  }
  if (name === 'review') renderReview()
  window.scrollTo(0, 0)
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
  $('intro-fill').style.strokeDashoffset = String(106.8 * (left / INTRO_S))
  if (t < INTRO_S) return
  $('intro-card').hidden = true
  if (t - rec.lastShotT >= rec.interval) void shoot(false)
}

function addLine(text) {
  if (!rec) return
  // A final result arrives when the sentence ends; date it from roughly when it started.
  const t = Math.max(0, elapsed() - words(text) * 0.35)
  rec.lines.push({ t, text })
  rec.words += words(text)
  $('stat-words').textContent = rec.words
  const box = $('live-transcript')
  box.querySelector('.muted')?.remove()
  box.querySelector('.interim')?.remove()
  box.append(el('p', {}, el('span', { className: 'line-time' }, fmt(t)), ' ', text))
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
  if (!SpeechRecognition || !$('f-transcript').checked) return
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
  if (!$('f-video').checked || !('MediaRecorder' in window)) return
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

async function start(event) {
  event.preventDefault()
  const error = $('setup-error')
  error.hidden = true
  const title = $('f-title').value.trim()
  if (!title) return
  if (!canShare) {
    error.textContent = "This browser can't share the screen. Use Chrome or Edge on a computer."
    error.hidden = false
    return
  }
  const button = $('start-btn')
  button.disabled = true
  let screen
  try {
    screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false })
  } catch (failure) {
    error.textContent = failure?.name === 'NotAllowedError'
      ? 'Screen sharing was cancelled. Choose a window to start recording.'
      : `The screen couldn't be shared: ${failure?.message || failure}`
    error.hidden = false
    button.disabled = false
    return
  }
  let mic = null
  if ($('f-mic').checked || $('f-transcript').checked) {
    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
    } catch {
      toast('No microphone: recording without your voice.')
    }
  }
  if (mic && !$('f-mic').checked) {
    // Only speech-to-text wanted: the browser's recognizer opens the microphone itself.
    for (const track of mic.getTracks()) track.stop()
    mic = null
  }
  button.disabled = false
  const track = screen.getVideoTracks()[0]
  rec = {
    title,
    role: $('f-role').value.trim(),
    interval: Number($('f-interval').value) || 5,
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
  const preview = $('preview')
  preview.srcObject = screen
  void preview.play().catch(() => undefined)
  $('live-strip').replaceChildren()
  $('live-transcript').replaceChildren(el('p', { className: 'muted' }, SpeechRecognition && $('f-transcript').checked ? 'Your words appear here as you speak.' : 'Speech-to-text is off.'))
  $('stat-shots').textContent = '0'
  $('stat-words').textContent = '0'
  $('mic-status').textContent = mic ? '' : $('f-mic').checked ? 'Recording without a microphone.' : ''
  $('intro-card').hidden = false
  $('rec-label').textContent = 'Recording'
  $('rec-dot').classList.remove('paused')
  $('pause-btn').textContent = 'Pause'
  startRecorder(screen, mic)
  startSpeech()
  rec.stopTicker = startTicker(tick)
  location.hash = '#/live'
  route()
  tick()
}

function togglePause() {
  if (!rec || rec.stopping) return
  if (!rec.paused) {
    rec.paused = true
    rec.pausedAt = Date.now()
    if (rec.recorder?.state === 'recording') rec.recorder.pause()
    try { rec.speech?.stop() } catch { /* ignore */ }
    $('rec-label').textContent = 'Paused'
    $('rec-dot').classList.add('paused')
    $('pause-btn').textContent = 'Resume'
  } else {
    rec.pausedTotal += Date.now() - rec.pausedAt
    rec.paused = false
    if (rec.recorder?.state === 'paused') rec.recorder.resume()
    if (rec.speech && !rec.speechOff) { try { rec.speech.start() } catch { /* ignore */ } }
    $('rec-label').textContent = 'Recording'
    $('rec-dot').classList.remove('paused')
    $('pause-btn').textContent = 'Pause'
  }
}

function autoTitle(note, n) {
  const sentence = note.split(/(?<=[.!?])\s/)[0].trim()
  if (!sentence) return `Step ${n}`
  const short = sentence.split(/\s+/).slice(0, 9).join(' ')
  return (short.length < sentence.length ? `${short}…` : short).replace(/^./, (c) => c.toUpperCase())
}

/** Turn screenshots and narration into a guide: what was said before the first screenshot is the introduction. */
function buildGuide(r, duration) {
  const steps = r.steps.slice()
  const firstShot = steps[0]?.t ?? Infinity
  const intro = r.lines.filter((l) => l.t < Math.min(INTRO_S + 2, firstShot)).map((l) => l.text).join(' ')
  const rest = r.lines.filter((l) => l.t >= Math.min(INTRO_S + 2, firstShot))
  steps.forEach((step, i) => {
    const from = i === 0 ? -Infinity : step.t
    const to = steps[i + 1]?.t ?? Infinity
    step.note = rest.filter((l) => l.t >= from && l.t < to).map((l) => l.text).join(' ')
    step.title = autoTitle(step.note, i + 1)
  })
  return { id: uid(), title: r.title, role: r.role, intro, created: Date.now(), duration, hasVideo: false, steps }
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
  if (!next.steps.length) toast('No screenshots were taken. Add a note, or record again.')
  await saveNew(next, blob)
  location.hash = '#/review'
  route()
}

// ------------------------------------------------------------------ review

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
  renderReview()
}

function remove(index) {
  const [step] = guide.steps.splice(index, 1)
  idb('readwrite', (s) => s.delete(`img:${step.id}`)).catch(() => undefined)
  saveSoon()
  renderReview()
  toast(`Step ${index + 1} deleted.`)
}

function stepCard(step, index) {
  const n = index + 1
  const title = el('input', { className: 'step-title', value: step.title, maxLength: 140, placeholder: `Step ${n}` })
  title.setAttribute('aria-label', `Title of step ${n}`)
  title.addEventListener('input', () => { step.title = title.value; saveSoon() })
  const note = el('textarea', { className: 'step-note', value: step.note, rows: 2, placeholder: 'What happens here, and why. What do you check before moving on?' })
  note.setAttribute('aria-label', `Notes for step ${n}`)
  note.addEventListener('input', () => { step.note = note.value; autoGrow(note); saveSoon() })
  requestAnimationFrame(() => autoGrow(note))
  const button = (label, text, onClick, disabled = false, extra = '') => {
    const b = el('button', { type: 'button', className: `icon ${extra}`, title: label, disabled }, text)
    b.setAttribute('aria-label', label)
    b.addEventListener('click', onClick)
    return b
  }
  const image = step.image
    ? el('img', { src: step.image, alt: `Screenshot for step ${n}`, loading: 'lazy' })
    : el('div', { className: 'no-image' }, 'No screenshot')
  const figure = el('button', { type: 'button', className: 'step-shot', title: 'Enlarge' }, image)
  if (step.image) figure.addEventListener('click', () => openLightbox(step.image))
  else figure.disabled = true
  return el('li', { className: 'card step' },
    figure,
    el('div', { className: 'step-body' },
      el('div', { className: 'step-top' },
        el('span', { className: 'step-num' }, String(n)),
        el('span', { className: 'step-time' }, `at ${fmt(step.t)}`),
        el('span', { className: 'step-tools' },
          button('Move up', '↑', () => move(index, -1), index === 0),
          button('Move down', '↓', () => move(index, 1), index === guide.steps.length - 1),
          button('Delete step', 'Delete', () => remove(index), false, 'danger-text'))),
      title,
      note))
}

function renderReview() {
  const has = !!guide
  $('review-empty').hidden = has
  $('review-body').hidden = !has
  if (!has) return
  $('review-title').textContent = guide.title
  const meta = [`${guide.steps.length} step${guide.steps.length === 1 ? '' : 's'}`, fmt(guide.duration), new Date(guide.created).toLocaleString()]
  if (guide.role) meta.push(`for ${guide.role}`)
  $('review-meta').textContent = meta.join(' · ')
  const intro = $('review-intro')
  intro.value = guide.intro
  requestAnimationFrame(() => autoGrow(intro))
  const list = $('guide-steps')
  list.replaceChildren(...guide.steps.map(stepCard))
  if (!guide.steps.length) list.append(el('li', { className: 'card empty-steps' }, 'No screenshots in this recording. The screen may not have changed, or the recording was shorter than the introduction.'))
  if (videoUrl) URL.revokeObjectURL(videoUrl)
  videoUrl = videoBlob ? URL.createObjectURL(videoBlob) : ''
  $('export-video').hidden = !videoBlob
  const video = $('review-video')
  $('video-section').hidden = !videoBlob
  if (videoBlob) video.src = videoUrl
  else video.removeAttribute('src')
}

function exportHtml() {
  if (!guide) return
  const para = (text) => text ? `<p>${esc(text).replace(/\n/g, '<br>')}</p>` : ''
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
  body{margin:0;background:#f4f3f8;color:#1c1b22;font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
  main{max-width:880px;margin:0 auto;padding:40px 20px 80px}
  .meta{color:#6e5ad6;font-weight:600;font-size:13px;letter-spacing:.04em;text-transform:uppercase;margin:0}
  h1{font-size:34px;line-height:1.15;margin:8px 0 12px}
  .intro{background:#fff;border:1px solid #e4e1ee;border-radius:12px;padding:16px 20px;margin:20px 0 28px}
  .step{background:#fff;border:1px solid #e4e1ee;border-radius:12px;padding:20px;margin:0 0 20px;break-inside:avoid}
  .step h2{display:flex;gap:12px;align-items:center;font-size:20px;margin:0 0 8px}
  .step h2 span{display:inline-grid;place-items:center;min-width:30px;height:30px;border-radius:50%;background:#6e5ad6;color:#fff;font-size:15px}
  .step p{margin:0 0 14px;color:#3b3946}
  .step img{display:block;width:100%;border-radius:8px;border:1px solid #e4e1ee}
  footer{color:#8b8898;font-size:13px;margin-top:32px}
</style></head>
<body><main>
  <p class="meta">Step-by-step guide${guide.role ? ` · for ${esc(guide.role)}` : ''}</p>
  <h1>${esc(guide.title)}</h1>
  ${guide.intro ? `<div class="intro">${para(guide.intro)}</div>` : ''}
  ${steps}
  <footer>Recorded with Apprentice on ${esc(new Date(guide.created).toLocaleDateString())}.</footer>
</main></body></html>`
  download(new Blob([html], { type: 'text/html' }), `${slug(guide.title)}.html`)
}

// ------------------------------------------------------------------ wiring

function init() {
  for (const a of document.querySelectorAll('[data-download]')) {
    a.href = DOWNLOAD_URL
    a.target = '_blank'
    a.rel = 'noopener'
  }
  try {
    if (localStorage.getItem('apprentice-banner') === 'hidden') $('desktop-banner').hidden = true
  } catch { /* storage may be blocked */ }
  $('banner-close').addEventListener('click', () => {
    $('desktop-banner').hidden = true
    try { localStorage.setItem('apprentice-banner', 'hidden') } catch { /* ignore */ }
  })
  if (!SpeechRecognition) {
    $('f-transcript').checked = false
    $('f-transcript').disabled = true
    $('transcript-hint').textContent = "Not available in this browser. Chrome and Edge can do it; the video still has your voice."
  }
  if (!canShare) {
    const error = $('setup-error')
    error.textContent = "This browser can't share the screen. Use Chrome or Edge on a computer."
    error.hidden = false
  }
  $('setup-form').addEventListener('submit', start)
  $('shot-btn').addEventListener('click', () => void shoot(true))
  $('pause-btn').addEventListener('click', togglePause)
  $('stop-btn').addEventListener('click', () => void stop())
  $('review-title').addEventListener('input', (e) => { if (guide) { guide.title = e.target.textContent.trim() || 'Untitled guide'; saveSoon() } })
  $('review-title').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur() } })
  $('review-intro').addEventListener('input', (e) => { if (guide) { guide.intro = e.target.value; autoGrow(e.target); saveSoon() } })
  $('export-html').addEventListener('click', exportHtml)
  $('export-pdf').addEventListener('click', () => window.print())
  $('export-video').addEventListener('click', () => {
    if (videoBlob) download(videoBlob, `${slug(guide?.title ?? 'recording')}.${videoBlob.type.includes('mp4') ? 'mp4' : 'webm'}`)
  })
  $('new-recording').addEventListener('click', () => { location.hash = '#/record' })
  $('lightbox').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close() })
  window.addEventListener('beforeunload', (e) => { if (rec) { e.preventDefault(); e.returnValue = '' } })
  window.addEventListener('hashchange', route)
  route()
  void loadSaved().then(() => { if (!location.hash.startsWith('#/review')) return; route() })
}

init()
