// Assembles the 59 s showcase picture from the film render and the real-app footage, following showcase/cues.js:
//   film segments   <- out/silent.mp4 (node render.mjs: the 66 s authored timeline, any frame rate), played 1.1x
//   footage inserts <- footage/app-session.mp4, cropped to the app, inside a framed plate (showcase/plate.html)
// joined with crossfades -> out/showcase/silent.mp4 (30 fps, ~9 Mbit/s). Then: node mix.mjs --film showcase
//
//   node showcase/edit.mjs [--film-video out/silent.mp4]

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { SEGMENTS, K, FADE, FPS, DURATION } from './cues.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const VIDEO = path.resolve(HERE, '..')
const OUT = path.join(VIDEO, 'out', 'showcase')
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > -1 ? process.argv[i + 1] : d }
const film = path.resolve(VIDEO, arg('film-video', 'out/silent.mp4'))
const footage = path.join(VIDEO, 'footage', 'app-session.mp4')
if (!fs.existsSync(film)) throw new Error(`No film render at ${film}. Run \`node render.mjs\` (e.g. --fps 15) first.`)
fs.mkdirSync(OUT, { recursive: true })

// 1. One frame plate per footage insert (transparent window, aura, label).
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })
const plates = []
for (const [i, s] of SEGMENTS.entries()) {
  if (s.src !== 'footage') continue
  await page.goto(`${pathToFileURL(path.join(HERE, 'plate.html')).href}?label=${encodeURIComponent(s.label)}`)
  await page.evaluate(() => document.fonts.ready)
  const file = path.join(OUT, `plate-${i}.png`)
  await page.screenshot({ path: file, omitBackground: true })
  plates[i] = file
}
await browser.close()

// 2. Trim, retime and frame every segment; each is padded by half a crossfade at its inner edges.
const HALF = FADE / 2
const inputs = ['-i', film, '-i', footage]
const filters = []
SEGMENTS.forEach((s, i) => {
  const padL = i > 0 ? HALF : 0, padR = i < SEGMENTS.length - 1 ? HALF : 0
  const dur = s.end - s.start + padL + padR
  const norm = `fps=${FPS},format=yuv420p,setsar=1,settb=AVTB,trim=duration=${dur.toFixed(3)}`
  if (s.src === 'film') {
    const a = s.from - padL / K, b = s.to + padR / K
    filters.push(`[0:v]trim=start=${a.toFixed(3)}:end=${b.toFixed(3)},setpts=(PTS-STARTPTS)*${K.toFixed(6)},scale=1920:1080,${norm}[s${i}]`)
  } else {
    const a = s.from - padL * s.speed, b = s.to + padR * s.speed
    inputs.push('-loop', '1', '-framerate', String(FPS), '-t', dur.toFixed(3), '-i', plates[i])
    const pi = inputs.filter((x) => x === '-i').length - 1
    filters.push(`[1:v]trim=start=${a.toFixed(3)}:end=${b.toFixed(3)},setpts=(PTS-STARTPTS)/${s.speed},fps=${FPS},crop=1700:956:100:60,scale=1600:900[f${i}]`)
    filters.push(`color=c=0x050505:s=1920x1080:r=${FPS}:d=${dur.toFixed(3)}[b${i}]`)
    filters.push(`[b${i}][f${i}]overlay=160:130:shortest=1[o${i}]`)
    filters.push(`[o${i}][${pi}:v]overlay=0:0:shortest=1,${norm}[s${i}]`)
  }
})
// 3. Crossfade them together; each fade is centred on the segment boundary.
let last = '[s0]'
SEGMENTS.slice(1).forEach((s, j) => {
  const i = j + 1
  filters.push(`${last}[s${i}]xfade=transition=fade:duration=${FADE}:offset=${(s.start - HALF).toFixed(3)}[x${i}]`)
  last = `[x${i}]`
})
filters.push(`${last}trim=duration=${DURATION},setpts=PTS-STARTPTS[v]`)

const out = path.join(OUT, 'silent.mp4')
const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', filters.join(';'), '-map', '[v]', '-an',
  '-c:v', 'libx264', '-preset', 'medium', '-b:v', '9M', '-maxrate', '11M', '-bufsize', '18M', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-movflags', '+faststart', out], { stdio: 'inherit' })
if (r.status) process.exit(r.status)
console.log(`wrote ${path.relative(VIDEO, out)}`)
