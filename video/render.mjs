// Renders the film frame by frame: serves the repo, opens video/index.html in headless Chromium,
// calls window.seek(t) for every frame and pipes the screenshots into ffmpeg.
//
//   node render.mjs                      full film -> out/silent.mp4
//   node render.mjs --preview 3,11.6,22  stills -> out/preview/*.jpg
//   node render.mjs --from 14 --to 29    a section (for quick checks) -> out/silent-14-29.mp4
//   node render.mjs --workers 3          parallel browser pages (default 3)
//   node render.mjs --fps 15             half the frames (about twice as fast); mix.mjs converts to 30 fps

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { DURATION, FPS } from './cues.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const OUT = path.join(HERE, 'out')
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > -1 ? process.argv[i + 1] : d }
const has = (k) => process.argv.includes(`--${k}`)
const RATE = Number(arg('fps', FPS)) // --fps 15 renders half the frames; mix.mjs retimes to 30 fps

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json' }
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname))
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end() }
  res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' })
  fs.createReadStream(p).pipe(res)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const URL_ = `http://127.0.0.1:${server.address().port}/video/index.html`

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--font-render-hinting=none'] })
async function openPage() {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[page]', m.text()) })
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))
  await page.goto(URL_)
  await page.waitForFunction(() => window.ready === true, null, { timeout: 120000 })
  const cdp = await page.context().newCDPSession(page)
  return { page, cdp }
}
async function shot({ page, cdp }, t, quality = 93) {
  await page.evaluate((t) => window.seek(t), t)
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality, optimizeForSpeed: true })
  return Buffer.from(data, 'base64')
}

fs.mkdirSync(OUT, { recursive: true })

if (has('preview')) {
  const dir = path.join(OUT, 'preview')
  fs.mkdirSync(dir, { recursive: true })
  const times = arg('preview', '1').split(',').map(Number)
  const p = await openPage()
  for (const t of times) {
    const t0 = Date.now()
    fs.writeFileSync(path.join(dir, `t${t.toFixed(2).padStart(5, '0')}.jpg`), await shot(p, t, 88))
    console.log(`t=${t} ${Date.now() - t0}ms`)
  }
} else {
  const from = Number(arg('from', 0)), to = Number(arg('to', DURATION))
  const workers = Number(arg('workers', 3))
  const total = Math.round((to - from) * RATE)
  const name = from === 0 && to === DURATION ? 'silent' : `silent-${from}-${to}`
  const per = Math.ceil(total / workers)
  const started = Date.now()
  let done = 0
  const chunk = async (w) => {
    const a = w * per, b = Math.min(total, a + per)
    if (a >= b) return null
    const file = path.join(OUT, `.${name}-part${w}.mp4`)
    const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(RATE), '-c:v', 'mjpeg', '-i', '-',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-pix_fmt', 'yuv420p', '-r', String(RATE), file], { stdio: ['pipe', 'inherit', 'inherit'] })
    const p = await openPage()
    for (let f = a; f < b; f++) {
      const buf = await shot(p, from + f / RATE)
      if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r))
      done++
      if (done % 60 === 0) {
        const el = (Date.now() - started) / 1000
        console.log(`${done}/${total} frames · ${(done / el).toFixed(1)} fps · eta ${Math.round((total - done) / (done / el))}s`)
      }
    }
    ff.stdin.end()
    await new Promise((r) => ff.on('close', r))
    await p.page.close()
    return file
  }
  const parts = (await Promise.all(Array.from({ length: workers }, (_, w) => chunk(w)))).filter(Boolean)
  const list = path.join(OUT, `.${name}-parts.txt`)
  fs.writeFileSync(list, parts.map((p) => `file '${p}'`).join('\n'))
  const out = path.join(OUT, `${name}.mp4`)
  await new Promise((r, j) => spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', out], { stdio: 'inherit' }).on('close', (c) => (c ? j(c) : r())))
  parts.forEach((p) => fs.unlinkSync(p)); fs.unlinkSync(list)
  console.log(`wrote ${out} in ${Math.round((Date.now() - started) / 1000)}s`)
}
await browser.close()
server.close()
