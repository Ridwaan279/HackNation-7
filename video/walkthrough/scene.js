// Protégé technical walkthrough (59 s). Every frame is a pure function of time: render.mjs --film walkthrough calls
// window.seek(t) and captures the page. Shared pieces (helpers, ghost, bubbles, dust, grain) come from ../scene.js.
// Layers: #bg (aura) < #ui (app mock-ups, CSS 3D) < #gl (Three.js: ghost, streams, knowledge graph) < #fx (cards, labels) < #type < #post.

import * as THREE from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { DURATION, LINES } from './cues.js'

// ------------------------------------------------------------------ helpers
const W = 1920, H = 1080
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x))
const lerp = (a, b, k) => a + (b - a) * k
const prog = (t, a, b) => clamp((t - a) / (b - a))
const E = {
  out: (k) => 1 - Math.pow(1 - k, 3),
  in: (k) => k * k * k,
  inOut: (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2),
  sine: (k) => -(Math.cos(Math.PI * k) - 1) / 2,
  expo: (k) => (k >= 1 ? 1 : 1 - Math.pow(2, -10 * k)),
  back: (k) => { const c = 1.6; return 1 + (c + 1) * Math.pow(k - 1, 3) + c * Math.pow(k - 1, 2) },
}
const sm = (t, a, b) => E.inOut(prog(t, a, b))
// Envelope: fades in over [a, a+fi], holds, fades out over [b-fo, b].
const env = (t, a, b, fi = 0.4, fo = 0.4) => Math.min(E.out(prog(t, a, a + fi)), fo > 0 ? 1 - E.in(prog(t, b - fo, b)) : t < b ? 1 : 0)
const drift = (t, s) => Math.sin(t * 0.71 + s) * 0.6 + Math.sin(t * 1.31 + s * 2.1) * 0.3 + Math.sin(t * 2.93 + s * 0.7) * 0.1
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}
// Keyframe track: [[t, value], ...] with per-segment easing.
function track(keys, t, ease = E.inOut) {
  if (t <= keys[0][0]) return keys[0][1]
  for (let i = 1; i < keys.length; i++) {
    const [t1, v1, e] = keys[i]
    if (t <= t1) {
      const [t0, v0] = keys[i - 1]
      const k = (e || ease)(prog(t, t0, t1))
      return Array.isArray(v0) ? v0.map((a, j) => lerp(a, v1[j], k)) : lerp(v0, v1, k)
    }
  }
  return keys[keys.length - 1][1]
}

const $ = (id) => document.getElementById(id)
function add(parent, html) {
  const d = document.createElement('div')
  d.innerHTML = html.trim()
  const n = d.firstElementChild
  parent.appendChild(n)
  return n
}
function op(n, o) {
  n.style.opacity = o
  n.style.visibility = o <= 0.002 ? 'hidden' : 'visible'
}
function place(n, x, y, extra = '') { n.style.transform = `translate3d(${x}px, ${y}px, 0) ${extra}` }

// Split text nodes into word and character spans for kinetic type.
function splitChars(root) {
  const walk = (node) => {
    for (const c of [...node.childNodes]) {
      if (c.nodeType === 3) {
        const frag = document.createDocumentFragment()
        for (const w of c.textContent.split(/(\s+)/)) {
          if (!w) continue
          if (/^\s+$/.test(w)) { frag.appendChild(document.createTextNode(' ')); continue }
          const ws = document.createElement('span')
          ws.className = 'word'
          for (const ch of w) {
            const s = document.createElement('span')
            s.className = 'ch'
            s.textContent = ch
            ws.appendChild(s)
          }
          frag.appendChild(ws)
        }
        c.replaceWith(frag)
      } else walk(c)
    }
  }
  walk(root)
  const chars = [...root.querySelectorAll('.ch')]
  const r = rng(chars.length * 7 + 3)
  chars.forEach((c) => { c._r = [r(), r(), r()] })
  return chars
}
function charReveal(chars, t, t0, o = {}) {
  const { stagger = 0.028, dur = 0.7, rise = 46, blur = 14, out = null, outDur = 0.7, outStagger = 0.012, scatter = false } = o
  chars.forEach((c, i) => {
    const p = E.out(prog(t, t0 + i * stagger, t0 + i * stagger + dur))
    let a = p, x = 0, y = (1 - p) * rise, b = (1 - p) * blur, r = 0
    if (out !== null) {
      const q = E.in(prog(t, out + i * outStagger, out + i * outStagger + outDur))
      a *= 1 - q
      b += q * blur * 1.4
      if (scatter) { x += q * (c._r[0] * 160 - 80); y -= q * (c._r[1] * 220 + 40); r = q * (c._r[2] * 90 - 45) } else y -= q * rise * 0.6
    }
    c.style.opacity = a
    c.style.transform = `translate(${x}px, ${y}px) rotate(${r}deg)`
    c.style.filter = b > 0.3 ? `blur(${b.toFixed(1)}px)` : 'none'
  })
}
// Words of a spoken line appear in time with the voice.
function wordsReveal(words, t, t0, dur) {
  const n = words.length
  words.forEach((w, i) => {
    const s = t0 + (i / n) * dur * 0.92
    const p = E.out(prog(t, s, s + 0.25))
    w.style.opacity = 0.18 + 0.82 * p
    w.style.filter = p < 1 ? `blur(${((1 - p) * 4).toFixed(1)}px)` : 'none'
  })
}
function splitWords(n) {
  const words = n.textContent.split(/\s+/).filter(Boolean)
  n.innerHTML = words.map((w) => `<span class="word">${w}</span>`).join(' ')
  return [...n.querySelectorAll('.word')]
}
const line = (id) => LINES.find((l) => l.id === id)
// Speaking amplitude, deterministic.
const voiceAmp = (t, l) => (t < l.t || t > l.t + l.max ? 0 : clamp(0.35 + 0.35 * Math.sin(t * 23) * Math.sin(t * 7.3 + 1) + 0.3 * Math.abs(Math.sin(t * 13.7))))

const stage = $('stage'), UI = $('ui'), FX = $('fx'), TY = $('type')

// ------------------------------------------------------------------ Three.js
const renderer = new THREE.WebGLRenderer({ canvas: $('gl'), antialias: true, alpha: true, preserveDrawingBuffer: true, premultipliedAlpha: true })
renderer.setPixelRatio(1)
renderer.setSize(W, H, false)
renderer.setClearColor(0x000000, 0)
renderer.toneMapping = THREE.NeutralToneMapping
renderer.toneMappingExposure = 1.0
renderer.outputColorSpace = THREE.SRGBColorSpace

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(35, W / H, 0.1, 200)
const pmrem = new THREE.PMREMGenerator(renderer)
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture

const C = { sky: new THREE.Color('#7cc7f4'), lav: new THREE.Color('#b38de8'), pink: new THREE.Color('#f59fdf'), white: new THREE.Color('#ffffff') }
// Slightly deeper tones for the ghost body so the gradient survives the lighting.
const GC = { top: new THREE.Color('#62b6f0'), mid: new THREE.Color('#a47ae8'), bot: new THREE.Color('#f28ad6') }

scene.add(new THREE.HemisphereLight(0xbfe4ff, 0x6a3a7a, 0.35))
const key = new THREE.DirectionalLight(0xffffff, 0.9)
key.position.set(-3, 5, 6)
scene.add(key)
const rimA = new THREE.PointLight(0x7cc7f4, 12, 20)
rimA.position.set(-4, 2, -2)
scene.add(rimA)
const rimB = new THREE.PointLight(0xf59fdf, 14, 20)
rimB.position.set(4, -1, -1.5)
scene.add(rimB)

// Additive blending that leaves the canvas alpha alone, so glows add light over the DOM layers underneath.
function glowBlend(m) {
  m.blending = THREE.CustomBlending
  m.blendEquation = THREE.AddEquation
  m.blendSrc = THREE.SrcAlphaFactor
  m.blendDst = THREE.OneFactor
  m.blendSrcAlpha = THREE.ZeroFactor
  m.blendDstAlpha = THREE.OneFactor
  m.transparent = true
  m.depthWrite = false
  m.toneMapped = false
  return m
}
function radialTex(stops) {
  const c = document.createElement('canvas')
  c.width = c.height = 256
  const g = c.getContext('2d')
  const gr = g.createRadialGradient(128, 128, 0, 128, 128, 128)
  for (const [o, col] of stops) gr.addColorStop(o, col)
  g.fillStyle = gr
  g.fillRect(0, 0, 256, 256)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}
const TEX = {
  glow: radialTex([[0, 'rgba(255,255,255,1)'], [0.25, 'rgba(255,255,255,0.45)'], [0.6, 'rgba(255,255,255,0.08)'], [1, 'rgba(255,255,255,0)']]),
  soft: radialTex([[0, 'rgba(255,255,255,0.9)'], [0.5, 'rgba(255,255,255,0.25)'], [1, 'rgba(255,255,255,0)']]),
}
function glowSprite(color, scale, opacity = 1) {
  const s = new THREE.Sprite(glowBlend(new THREE.SpriteMaterial({ map: TEX.glow, color, opacity })))
  s.scale.setScalar(scale)
  s.userData.base = opacity
  return s
}

// --- ghost ------------------------------------------------------------------
const GU = 120, GV = 80, VD = 0.42
function ghostPoint(theta, v, phase, out) {
  let r, y
  if (v < VD) {
    const phi = (v / VD) * Math.PI / 2
    r = Math.sin(phi)
    y = 0.32 + Math.cos(phi) * 1.08
  } else {
    const s = (v - VD) / (1 - VD)
    r = 1 + 0.12 * s * s
    y = 0.32 - s * 1.5
    const hem = Math.pow(clamp((s - 0.7) / 0.3), 2)
    y += hem * (0.15 * Math.sin(theta * 5 + phase) + 0.05 * Math.sin(theta * 3 - phase * 1.3))
    r += hem * 0.05 * Math.sin(theta * 5 + phase + 1.0)
  }
  out.set(r * Math.sin(theta), y, r * Math.cos(theta) * 0.88)
  return out
}
const ghostGeo = new THREE.BufferGeometry()
{
  const n = (GU + 1) * (GV + 1)
  ghostGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3))
  ghostGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3))
  const idx = []
  for (let j = 0; j < GV; j++) for (let i = 0; i < GU; i++) {
    const a = j * (GU + 1) + i, b = a + GU + 1
    idx.push(a, b, a + 1, b, b + 1, a + 1)
  }
  ghostGeo.setIndex(idx)
}
let ghostPhase = null
function updateGhostGeo(phase) {
  if (ghostPhase !== null && Math.abs(phase - ghostPhase) < 1e-4) return
  ghostPhase = phase
  const p = ghostGeo.attributes.position.array, col = ghostGeo.attributes.color.array
  const v3 = new THREE.Vector3(), c = new THREE.Color()
  for (let j = 0; j <= GV; j++) for (let i = 0; i <= GU; i++) {
    const k = (j * (GU + 1) + i) * 3
    ghostPoint((i / GU) * Math.PI * 2, j / GV, phase, v3)
    p[k] = v3.x; p[k + 1] = v3.y; p[k + 2] = v3.z
    const h = clamp((v3.y + 1.25) / 2.65)
    if (h > 0.5) c.copy(GC.mid).lerp(GC.top, (h - 0.5) / 0.5)
    else c.copy(GC.bot).lerp(GC.mid, h / 0.5)
    c.lerp(C.white, 0.04 + 0.06 * h)
    col[k] = c.r; col[k + 1] = c.g; col[k + 2] = c.b
  }
  ghostGeo.attributes.position.needsUpdate = true
  ghostGeo.attributes.color.needsUpdate = true
  ghostGeo.computeVertexNormals()
}
const ghostMat = new THREE.MeshPhysicalMaterial({
  vertexColors: true, roughness: 0.3, metalness: 0, clearcoat: 0.5, clearcoatRoughness: 0.1, side: THREE.DoubleSide,
  sheen: 0.1, sheenColor: new THREE.Color('#e7d6ff'), envMapIntensity: 0.4,
})
ghostMat.userData.glow = { value: 0.4 }
ghostMat.onBeforeCompile = (sh) => {
  sh.uniforms.uGlow = ghostMat.userData.glow
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', '#include <common>\nuniform float uGlow;')
    .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance += vColor.rgb * uGlow * (gl_FrontFacing ? 1.0 : 0.35);')
}
const ghost = new THREE.Group()
const ghostBody = new THREE.Group()
ghost.add(ghostBody)
const ghostMesh = new THREE.Mesh(ghostGeo, ghostMat)
ghostBody.add(ghostMesh)
const eyes = []
{
  const eg = new THREE.SphereGeometry(1, 32, 24)
  const em = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false })
  const v = new THREE.Vector3()
  for (const s of [-1, 1]) {
    const theta = s * 0.34
    ghostPoint(theta, 0.37, 0, v)
    const e = new THREE.Mesh(eg, em)
    e.position.copy(v).multiplyScalar(1.004)
    e.lookAt(v.clone().multiplyScalar(2).setY(v.y))
    e.scale.set(0.12, 0.175, 0.04)
    ghostBody.add(e)
    const g = glowSprite(0xf0e8ff, 0.55, 0.4)
    g.position.copy(v).multiplyScalar(1.06)
    ghostBody.add(g)
    eyes.push(e)
  }
}
const ghostHalo = glowSprite(0xb38de8, 7.5, 0.55)
ghostHalo.position.set(0, 0.1, -0.6)
ghost.add(ghostHalo)
const ghostHalo2 = glowSprite(0x7cc7f4, 4.2, 0.35)
ghostHalo2.position.set(-0.6, 0.9, -0.4)
ghost.add(ghostHalo2)
const floor = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), glowBlend(new THREE.MeshBasicMaterial({ map: TEX.soft, color: 0x8a52d8, opacity: 0.75 })))
floor.rotation.x = -Math.PI / 2
floor.position.y = -1.6
floor.scale.set(5.2, 2.6, 1)
ghost.add(floor)
scene.add(ghost)

// --- bubbles ------------------------------------------------------------------
// Soap bubbles: fresnel rim with a thin-film hue shift and two specular glints, added as light.
const bubbleMat = glowBlend(new THREE.ShaderMaterial({
  uniforms: { uT: { value: 0 } },
  vertexShader: `varying vec3 vN; varying vec3 vV;
    void main(){ vec4 mv=modelViewMatrix*vec4(position,1.0); vN=normalize(normalMatrix*normal); vV=normalize(-mv.xyz); gl_Position=projectionMatrix*mv; }`,
  fragmentShader: `varying vec3 vN; varying vec3 vV; uniform float uT;
    vec3 hue(float h){ return clamp(abs(mod(h*6.0+vec3(0.0,4.0,2.0),6.0)-3.0)-1.0,0.0,1.0); }
    void main(){ float d=abs(dot(vN,vV)); float f=pow(1.0-d,2.2);
      vec3 film=mix(vec3(0.55,0.75,1.0), hue(f*1.4+vN.y*0.35+uT*0.05), 0.65);
      float s1=pow(max(dot(vN,normalize(vec3(-0.45,0.55,0.7))),0.0),70.0);
      float s2=pow(max(dot(vN,normalize(vec3(0.5,-0.35,0.8))),0.0),140.0);
      vec3 c=film*f*0.95 + vec3(1.0)*s1*1.6 + vec3(1.0,0.75,0.95)*s2*1.2 + vec3(0.06,0.05,0.09);
      gl_FragColor=vec4(c,1.0); }`,
}))
const bubbles = new THREE.Group()
const BUB = [[-2.3, 1.3, -0.4, 0.4], [2.35, 1.55, -1, 0.3], [2.55, -0.75, 0.3, 0.46], [-2.05, -1.15, 0.5, 0.3], [-3.4, 0.2, -2.2, 0.22], [3.5, 0.45, -2.6, 0.24]]
const bubbleGeo = new THREE.SphereGeometry(1, 48, 32)
BUB.forEach(([x, y, z, r], i) => {
  const m = new THREE.Mesh(bubbleGeo, bubbleMat)
  m.position.set(x, y, z)
  m.scale.setScalar(r)
  m.userData.base = [x, y, z, r]
  const g = glowSprite(i % 2 ? 0xf59fdf : 0x7cc7f4, 0.9, 0.8)
  g.position.set(i % 2 ? 0.75 : -0.7, i % 2 ? -0.55 : 0.65, 0.4)
  m.add(g)
  bubbles.add(m)
})
scene.add(bubbles)

// --- dust (ambient particles) ----------------------------------------------------
const pointsMat = (sizeScale = 1) => glowBlend(new THREE.ShaderMaterial({
  uniforms: { uScale: { value: (H / (2 * Math.tan(THREE.MathUtils.degToRad(17.5)))) * sizeScale }, uAlpha: { value: 1 } },
  vertexShader: `attribute float size; attribute vec3 tint; attribute float alpha; varying vec3 vC; varying float vA;
    uniform float uScale;
    void main(){ vC=tint; vA=alpha; vec4 mv=modelViewMatrix*vec4(position,1.0); gl_PointSize=size*uScale/max(0.1,-mv.z); gl_Position=projectionMatrix*mv; }`,
  fragmentShader: `varying vec3 vC; varying float vA; uniform float uAlpha;
    void main(){ float d=length(gl_PointCoord-0.5); float a=smoothstep(0.5,0.0,d); a*=a; gl_FragColor=vec4(vC*1.6, a*vA*uAlpha); }`,
}))
function makePoints(n, mat) {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3))
  g.setAttribute('tint', new THREE.BufferAttribute(new Float32Array(n * 3), 3))
  g.setAttribute('size', new THREE.BufferAttribute(new Float32Array(n), 1))
  g.setAttribute('alpha', new THREE.BufferAttribute(new Float32Array(n), 1))
  const p = new THREE.Points(g, mat)
  p.frustumCulled = false
  scene.add(p)
  return p
}
const PAL = [C.sky, C.lav, C.pink, C.white]
const DUST_N = 700
const dust = makePoints(DUST_N, pointsMat())
const dustSeed = []
{
  const r = rng(11)
  for (let i = 0; i < DUST_N; i++) {
    dustSeed.push([r() * 30 - 15, r() * 18 - 9, r() * 24 - 18, r() * 6.28, r()])
    const c = PAL[(r() * 4) | 0]
    dust.geometry.attributes.tint.setXYZ(i, c.r, c.g, c.b)
    dust.geometry.attributes.size.setX(i, 0.015 + r() * 0.04)
  }
}
function updateDust(t, a) {
  dust.visible = a > 0.001
  if (!dust.visible) return
  const P = dust.geometry.attributes.position, A = dust.geometry.attributes.alpha
  dustSeed.forEach(([x, y, z, ph, s], i) => {
    P.setXYZ(i, x + Math.sin(t * 0.2 + ph) * 0.4, y + ((t * 0.12 * (0.3 + s)) % 18), z)
    A.setX(i, a * (0.25 + 0.55 * (0.5 + 0.5 * Math.sin(t * (1 + s * 2) + ph))))
  })
  P.needsUpdate = true
  A.needsUpdate = true
}

const tmpV = new THREE.Vector3()
// ------------------------------------------------------------------ projection helpers
function toScreen(v) {
  tmpV.copy(v).project(camera)
  return { x: (tmpV.x * 0.5 + 0.5) * W, y: (-tmpV.y * 0.5 + 0.5) * H, z: tmpV.z }
}
const ray = new THREE.Raycaster()
function screenToWorld(sx, sy, z = 0) {
  ray.setFromCamera(new THREE.Vector2((sx / W) * 2 - 1, -(sy / H) * 2 + 1), camera)
  const k = (z - ray.ray.origin.z) / ray.ray.direction.z
  return ray.ray.origin.clone().addScaledVector(ray.ray.direction, k)
}

// ------------------------------------------------------------------ post FX
const grainEl = $('grain')
const grainTex = []
{
  const r = rng(5)
  for (let k = 0; k < 6; k++) {
    const c = document.createElement('canvas')
    c.width = c.height = 256
    const g = c.getContext('2d'), img = g.createImageData(256, 256)
    for (let i = 0; i < img.data.length; i += 4) { const v = (r() * 255) | 0; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255 }
    g.putImageData(img, 0, 0)
    grainTex.push(`url(${c.toDataURL()})`)
  }
}

// ------------------------------------------------------------------ DOM: titles and corner labels
function title(html, top, cls = '') { return add(TY, `<div class="title ${cls}" style="top:${top}px">${html}</div>`) }
const corner = (n, name) => add(TY, `<div class="corner"><b>${n}</b><i></i>${name}</div>`)
const T = {}
T.gapO = title('<div class="overline">The onboarding gap</div>', 190)
T.gap1 = title('<div class="big" style="font-size:84px">One recorded <span class="serif">hour.</span></div>', 236)
T.gap2 = title('<div class="big" style="font-size:84px">The rest of the year is <span class="serif">lost.</span></div>', 236)
T.gap3 = title('<div class="big" style="font-size:84px">Protégé learns <span class="serif">all year.</span></div>', 236)
T.co1 = corner('01', 'Windows UI Automation')
T.co2 = corner('02', 'Always on · every expert')
T.co3 = corner('03', 'A growing knowledge base')
T.co4 = corner('04', 'Guided pointing')
T.always = title('<span class="chip glass" style="padding:13px 20px;font-size:17px">No sessions to schedule&nbsp;&nbsp;·&nbsp;&nbsp;No one interrupted&nbsp;&nbsp;·&nbsp;&nbsp;Masked text, stored locally</span>', 930)
T.endMark = title('<div class="endmark"><span class="grad">Protégé</span></div>', 560)
T.endTag = title('<div class="mid">Always learning. <span class="serif" style="color:var(--ink)">Ready to teach anyone.</span></div>', 800)
T.endPills = title('<div class="pills"><span class="chip mono">Windows UI Automation</span><span class="chip mono">Always on</span><span class="chip mono">Guided pointing</span></div>', 872)
T.credit = title('<div class="overline" style="font-size:13px">Technical walkthrough · Windows desktop app</div>', 960)
const chars = {
  gapO: splitChars(T.gapO), gap1: splitChars(T.gap1), gap2: splitChars(T.gap2), gap3: splitChars(T.gap3), endTag: splitChars(T.endTag),
}

// ------------------------------------------------------------------ DOM: scene 1, one recorded hour on a year of work
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
const YW = 1500, REC_X = 282
const year = add(FX, `<div class="year"><div class="track"></div><div class="fill"></div>
  ${MONTHS.map((m, i) => `<div class="tick" style="left:${(i / 12) * YW}px"></div><div class="mo" style="left:${((i + 0.5) / 12) * YW}px">${m}</div>`).join('')}
  <div class="reclab" style="left:${REC_X}px">● REC 1:00:00 · onboarding session</div><div class="rec" style="left:${REC_X}px"></div>
  <div class="yearcap">Protégé · every working hour, all year</div></div>`)
const yFill = year.querySelector('.fill'), yRec = year.querySelector('.rec'), yRecLab = year.querySelector('.reclab'), yCap = year.querySelector('.yearcap')
const HL = [
  { x: 610, top: -14, m: 'May', t: 'Checks the VAT ID on every new supplier' },
  { x: 860, top: 178, m: 'Jul', t: 'Holds invoices that arrive without a PO' },
  { x: 1120, top: -14, m: 'Sep', t: 'Calls Elbe before paying a duplicate' },
  { x: 1340, top: 178, m: 'Nov', t: 'Codes freight to 6200, not 6100' },
]
const DOTS = []
{
  const r = rng(7)
  for (let i = 0; i < 44; i++) {
    const x = 12 + r() * 1476
    if (Math.abs(x - REC_X) < 24) continue
    DOTS.push({ x, y: 100 + (r() - 0.5) * 56 })
  }
  DOTS.push({ x: REC_X - 4, y: 92, got: true }, { x: REC_X + 5, y: 109, got: true })
  HL.forEach((h) => DOTS.push({ x: h.x, y: 100, key: true }))
  DOTS.forEach((d) => { d.n = add(year, `<div class="hdot ${d.got ? 'got' : ''}" style="left:${d.x}px;top:${d.y}px"></div>`) })
}
HL.forEach((h) => {
  h.n = add(year, `<div class="hlab" style="left:${h.x}px;top:${h.top}px"><small>${h.m}</small>${h.t}<span class="x"></span><span class="lost">never mentioned</span></div>`)
  h.x_ = h.n.querySelector('.x'); h.lost = h.n.querySelector('.lost')
})

// ------------------------------------------------------------------ DOM: MiniERP windows
const CURSOR = '<svg class="cursor" viewBox="0 0 24 24"><path d="M3 2l15 10.5-6.6 1.3 3.8 7.3-3 1.5-3.8-7.4L3 20z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>'
function erp(o) {
  const list = o.list.map((x, i) => `<div class="inv ${i === 0 ? 'on' : ''}">${x[0]}<b>${x[1]}</b><span class="amt">${x[2]}</span><span class="st">Pending</span></div>`).join('')
  const f = ([id, label, val, cls = '', hint = '']) =>
    `<div class="f ${cls}"><label>${label}</label><div class="in ${cls.includes('sel') ? 'sel' : ''}" data-f="${id}"><span class="v">${val}</span></div>${hint ? `<div class="hint">${hint}</div>` : ''}</div>`
  return add(UI, `<div class="win" style="left:0;top:0">
    <div class="chrome"><span class="ico"></span>MiniERP · Finance workspace<span class="ctl"><span>—</span><span>▢</span><span>✕</span></span></div>
    <div class="addr"><span class="nav">← → ⟳</span><span class="url">minierp.local/accounts-payable/${o.id}</span></div>
    <div class="top"><span class="logo">MiniERP</span><span class="ws">Finance workspace</span><span class="demo">Local demo · Synthetic data</span><span class="av">${o.user}</span></div>
    <div class="page">
      <div class="eyebrow">ACCOUNTS PAYABLE</div><h1>Invoice inbox</h1><div class="sub">Review, code and route supplier invoices.</div>
      <div class="grid"><div class="list"><div class="hd">Invoices <span>${o.list.length} pending</span></div>${list}</div>
        <div class="detail"><div class="eyebrow">INVOICE DETAILS</div><h2>${o.id}</h2><span class="status">Pending</span>
          <div class="fields">${o.fields.map(f).join('')}</div>
          <div class="actions">${o.actions.map(([id, txt, cls = '']) => `<span class="btn ${cls}" data-f="${id}">${txt}</span>`).join('')}</div>
        </div></div>
    </div>
    <div class="dim"></div>
    <div class="scan"></div>
    <div class="ripple"></div><div class="ripple"></div>
    ${CURSOR}
  </div>`)
}
const winA = erp({
  id: 'INV-4471', user: 'S',
  list: [['INV-4471', 'Nordwerk Equipment', '€6,400.00'], ['INV-4472', 'Müller GmbH', '€1,850.00'], ['INV-4473', 'Brenner Components', '€2,390.00']],
  fields: [
    ['sup', 'Supplier', 'Nordwerk Equipment'], ['amt', 'Amount (EUR)', '6400.00'], ['desc', 'Description', 'Production equipment: milling unit', 'wide'],
    ['date', 'Invoice date', '10/04/2026'], ['pin', 'Approval PIN', '••••••'],
    ['cc', 'Cost center', '6100', 'sel', '6100 · Operating expense / 0400 · Capital expenditure'], ['asset', 'Asset number', 'AS-2026-087'],
    ['bank', 'Bank details', 'DE89 3704 0044 0532 0130 00', 'wide'],
  ],
  actions: [['draft', 'Save draft'], ['post', 'Post invoice', 'primary']],
})
const winB = erp({
  id: 'INV-5801', user: 'J',
  list: [['INV-5801', 'Elbe Industrial', '€7,200.00'], ['INV-5802', 'Bürobedarf West', '€240.00']],
  fields: [
    ['sup', 'Supplier', 'Elbe Industrial'], ['amt', 'Amount (EUR)', '7200.00'], ['desc', 'Description', 'Production equipment: inspection station', 'wide'],
    ['date', 'Invoice date', '10/04/2026'], ['sub', 'Subsidiary', 'Germany', 'sel'],
    ['cc', 'Cost center', '0400', 'sel'], ['pon', 'Purchase order', '<span class="ph">Not matched yet</span>'],
    ['bank', 'Bank details', 'DE02 1203 0000 0000 2020 51', 'wide'],
  ],
  actions: [['draft', 'Save draft'], ['matchpo', 'Match PO'], ['post', 'Post invoice', 'primary']],
})
function relRect(el, root) {
  let x = 0, y = 0, e = el
  while (e && e !== root) { x += e.offsetLeft; y += e.offsetTop; e = e.offsetParent }
  return { x, y, w: el.offsetWidth, h: el.offsetHeight, cx: x + el.offsetWidth / 2, cy: y + el.offsetHeight / 2 }
}
function winParts(win) {
  const q = (s) => win.querySelector(s)
  const fields = {}
  win.querySelectorAll('[data-f]').forEach((n) => { fields[n.dataset.f] = n })
  return { win, q, fields, cursor: q('.cursor'), ripples: [...win.querySelectorAll('.ripple')], scan: q('.scan'), dim: q('.dim'), menu: q('.menu'), list: q('.inv') }
}
const A = winParts(winA), B = winParts(winB)
function addTag(P, f, text, cls = '') {
  return add(P.win, `<div class="ftag ${cls}"><span>${text}</span></div>`)
}
function setWin(P, { cx, cy, s, rx, ry, rz = 0, z = 0, o = 1, filter = 'none' }) {
  P.win.style.left = `${cx - 720}px`
  P.win.style.top = `${cy - 440}px`
  P.win.style.transform = `translateZ(${z}px) rotateX(${rx}deg) rotateY(${ry}deg) rotateZ(${rz}deg) scale(${s})`
  P.win.style.filter = filter
  op(P.win, o)
}
function setCursor(P, path, t, clicks) {
  const [x, y] = track(path, t)
  place(P.cursor, x - 4, y - 2)
  let i = 0
  for (const ct of clicks) {
    const r = P.ripples[i++ % P.ripples.length]
    const k = prog(t, ct, ct + 0.55)
    if (k > 0 && k < 1) {
      const [cx, cy] = track(path, ct)
      r.style.left = `${cx}px`; r.style.top = `${cy}px`
      r.style.transform = `scale(${0.3 + E.out(k) * 1.4})`
      op(r, 1 - k)
    } else if (!(r._t === ct)) { /* keep other ripple state */ }
  }
  // hide ripples that are not active
  P.ripples.forEach((r) => {
    const active = clicks.some((ct) => t > ct && t < ct + 0.55)
    if (!active) op(r, 0)
  })
}
function setVal(P, f, html) { const v = P.fields[f].querySelector('.v'); if (v.innerHTML !== html) v.innerHTML = html }
function rectOf(P, f) { return relRect(P.fields[f], P.win) }
function screenRect(el) { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 } }

function bubble(cls, who, text) {
  const left = cls === 'sabine' ? '<div class="av">S</div>' : '<div class="wave">' + '<i></i>'.repeat(7) + '</div>'
  const n = add(FX, `<div class="bubble glass ${cls}">${left}<div><div class="who">${who}</div><div class="txt">${text}</div></div></div>`)
  return { n, words: splitWords(n.querySelector('.txt')), bars: [...n.querySelectorAll('.wave i')] }
}
function setBubble(b, x, y, a, t, l, scale = 1) {
  op(b.n, a)
  place(b.n, x, y, `scale(${scale})`)
  if (a <= 0) return
  wordsReveal(b.words, t, l.t, l.max)
  const amp = voiceAmp(t, l)
  b.bars.forEach((bar, i) => { bar.style.height = `${6 + amp * 30 * (0.4 + 0.6 * Math.abs(Math.sin(t * (9 + i * 2.3) + i)))}px` })
}

// Speed lines behind the flying ghost.
const speed = add(FX, '<div style="width:220px;height:90px;opacity:0;transform-origin:100% 50%"><i style="position:absolute;right:0;top:12px;width:150px;height:10px;border-radius:6px;background:#7cc7f4;box-shadow:0 0 14px #7cc7f4"></i><i style="position:absolute;right:30px;top:40px;width:200px;height:10px;border-radius:6px;background:#b38de8;box-shadow:0 0 14px #b38de8"></i><i style="position:absolute;right:0;top:68px;width:140px;height:10px;border-radius:6px;background:#f59fdf;box-shadow:0 0 14px #f59fdf"></i></div>')


// ------------------------------------------------------------------ DOM: scene 2, accessibility tree + events + pipeline
const TAGS = [
  ['sup', 'Edit · "Supplier"'], ['amt', 'Edit · "Amount (EUR)"'], ['cc', 'ComboBox · "Cost center"'],
  ['pin', 'Edit · IsPassword → never read', 'mask'], ['bank', 'Edit · "Bank details" → masked', 'mask'], ['post', 'Button · "Post invoice"'],
].map(([f, text, cls]) => {
  const r = rectOf(A, f)
  const n = addTag(A, f, text, cls)
  Object.assign(n.style, { left: `${r.x - 4}px`, top: `${r.y - 4}px`, width: `${r.w + 8}px`, height: `${r.h + 8}px` })
  return { n, r, f }
})
const TREE = [
  [0, 'Window', '"MiniERP · Finance workspace"', ''],
  [1, 'Pane', '"Invoice INV-4471"', ''],
  [2, 'Edit', '"Supplier"', 'Nordwerk Equipment'],
  [2, 'Edit', '"Amount (EUR)"', '6400.00'],
  [2, 'ComboBox', '"Cost center"', '6100'],
  [2, 'Edit', '"Bank details"', 'DE89 3704 0044 …'],
  [2, 'Button', '"Post invoice"', 'Invoke'],
  [2, 'Edit', '"Approval PIN"', 'IsPassword · skipped', 'pw'],
]
const TREE_T = [10.0, 10.45, 10.9, 11.35, 11.8, 12.05, 12.25, 12.5]
const tree = add(FX, `<div class="xpanel glass"><div class="hd"><b>Accessibility tree</b>· UI Automation<span class="tag">text, not pixels</span></div>
  ${TREE.map(([d, ct, nm, vl, cls = '']) => `<div class="trow ${cls}" style="padding-left:${10 + d * 24}px"><span class="ct">${ct}</span><span class="nm">${nm}</span><span class="vl">${vl}</span></div>`).join('')}</div>`)
const trows = [...tree.querySelectorAll('.trow')]
const s = (v, m = '') => `<span class="s ${m}">"${v}"</span>`
const EVENTS = [
  [14.3, `{"type":${s('context')},"app":${s('MiniERP')},"title":${s('INV-4471')}}`],
  [14.95, `{"type":${s('click')},"target":${s('Cost center')},"control_type":${s('ComboBox')}}`],
  [15.9, `{"type":${s('commit')},"field":${s('Cost center')},"old":${s('6100')},"new":${s('0400')}}`],
  [17.0, `{"type":${s('commit')},"field":${s('Bank details')},"new":${s('DE•• •••• 3000', 'm')},"masked":<span class="b">true</span>}`],
  [19.45, `{"type":${s('click')},"target":${s('Post invoice')},"control_type":${s('Button')}}`],
]
const events = add(FX, `<div class="xpanel glass"><div class="hd"><b>Events</b>· JSON lines on stdout<span class="tag">masked before emit</span></div>
  <div style="margin-top:10px">${EVENTS.map(([, h]) => `<div class="ev">${h}</div>`).join('')}</div></div>`)
const evs = [...events.querySelectorAll('.ev')]
const pipe = add(FX, `<div class="pipe"><span class="pc">UI Automation</span><span class="ar">→</span><span class="pc">privacy gate</span><span class="ar">→</span><span class="pc">redact.py</span><span class="ar">→</span><span class="pc">event</span></div>`)
const pipeC = [...pipe.querySelectorAll('.pc')]

// ------------------------------------------------------------------ DOM: scene 3, experts, day counter, habits
const EXPERTS = [
  { nm: 'Sabine', rl: 'Accounts payable · MiniERP', av: 'linear-gradient(140deg,#f3d7c6,#d6a98f)', x: 110, y: 250, sp: 34,
    feed: [['commit', 'Cost center → 0400'], ['click', 'Post invoice'], ['commit', 'IBAN → <span class="m">DE•• •••• 3000</span>'], ['text', '12 new lines · masked'], ['click', 'Match PO'], ['commit', 'Asset number → AS-2026-087']] },
  { nm: 'Tomasz', rl: 'Procurement · SAP', av: 'linear-gradient(140deg,#c6e4f3,#8fbcd6)', x: 1430, y: 250, sp: 29,
    feed: [['click', 'Create purchase order'], ['commit', 'Vendor → Elbe Industrial'], ['commit', 'Incoterms → DAP'], ['click', 'Release'], ['text', '8 new lines · masked'], ['commit', 'Quantity → 4']] },
  { nm: 'Amira', rl: 'Treasury · Excel', av: 'linear-gradient(140deg,#d9f3c6,#9fd68f)', x: 110, y: 690, sp: 26,
    feed: [['commit', 'B14 → 182,400.00'], ['click', 'Refresh all'], ['text', 'Cash forecast · 31 cells'], ['commit', 'FX rate → 1.0842'], ['click', 'Save'], ['commit', 'Card → <span class="m">•••• 4242</span>']] },
  { nm: 'Lena', rl: 'Vendor desk · Outlook', av: 'linear-gradient(140deg,#e9d2f7,#b99ad8)', x: 1430, y: 690, sp: 31,
    feed: [['text', 'Supplier mail · 6 lines'], ['click', 'Reply'], ['commit', 'Subject → Duplicate invoice'], ['click', 'Flag'], ['text', 'Remittance advice · masked'], ['click', 'Move to AP folder']] },
].map((e) => {
  e.n = add(FX, `<div class="xcard glass"><div class="top"><div class="av" style="background:${e.av}">${e.nm[0]}</div><div><div class="nm">${e.nm}</div><div class="rl">${e.rl}</div></div><div class="lv"><i></i>Learning</div></div>
    <div class="feed">${e.feed.map(([k, v]) => `<div><b>${k}</b>${v}</div>`).join('')}</div></div>`)
  e.lines = [...e.n.querySelectorAll('.feed div')]
  return e
})
const counter = add(TY, '<div class="counter"><div class="k">Always on · all day · all year</div><div class="d"><span>DAY 001</span></div><div class="bar"><i></i></div></div>')
const counterD = counter.querySelector('.d span'), counterBar = counter.querySelector('.bar i')
const HABITS = [
  { x: 690, y: 485, t: 'Checks the VAT ID on every new supplier' },
  { x: 1235, y: 455, t: 'Holds invoices that arrive without a PO' },
  { x: 690, y: 655, t: 'Calls Elbe before paying a duplicate' },
  { x: 1235, y: 690, t: 'Codes freight to 6200, not 6100' },
].map((h) => ({ ...h, n: add(FX, `<div class="habit glass"><small>Never mentioned in training</small>${h.t}</div>`) }))

// Data streams from each expert to the ghost (Three.js points).
const ST_PER = 80, ST_N = EXPERTS.length * ST_PER
const streams = makePoints(ST_N, pointsMat())
const stSeed = []
{
  const r = rng(31)
  for (let i = 0; i < ST_N; i++) {
    stSeed.push([r(), r(), r()])
    const c = PAL[(r() * 4) | 0]
    streams.geometry.attributes.tint.setXYZ(i, c.r, c.g, c.b)
    streams.geometry.attributes.size.setX(i, 0.03 + r() * 0.04)
  }
}
function updateStreams(t, a, gpos) {
  streams.visible = a > 0.001
  if (!streams.visible) return
  const P = streams.geometry.attributes.position, AL = streams.geometry.attributes.alpha
  const ends = EXPERTS.map((e) => screenToWorld(e.x + 190, e.y + 95))
  for (let i = 0; i < ST_N; i++) {
    const [u0, v, w] = stSeed[i], e = ends[(i / ST_PER) | 0]
    const u = (u0 + (t - 21) * (0.22 + 0.18 * v)) % 1
    const mx = (e.x + gpos.x) / 2 - (gpos.y - e.y) * 0.18 * (w - 0.3), my = (e.y + gpos.y) / 2 + (gpos.x - e.x) * 0.18 * (w - 0.3)
    const a0 = (1 - u) * (1 - u), a1 = 2 * (1 - u) * u, a2 = u * u
    P.setXYZ(i, a0 * e.x + a1 * mx + a2 * gpos.x + Math.sin(u * 17 + i) * 0.04, a0 * e.y + a1 * my + a2 * gpos.y + Math.cos(u * 13 + i) * 0.04, Math.sin(u * 9 + i) * 0.2)
    AL.setX(i, a * Math.pow(Math.sin(u * Math.PI), 0.6) * (0.35 + 0.65 * w))
  }
  P.needsUpdate = true
  AL.needsUpdate = true
}

// ------------------------------------------------------------------ scene 4: the knowledge graph (Three.js) and the profile panel
const graph = new THREE.Group()
scene.add(graph)
const CL = [
  { name: 'MiniERP', ic: 'M', bg: '#24574a', c: [-1.95, 1.15, 0.2], n: 18420 },
  { name: 'Excel', ic: 'X', bg: '#1f7a4a', c: [1.8, 1.0, -0.5], n: 9310 },
  { name: 'Outlook', ic: 'O', bg: '#2a62c9', c: [-1.65, -1.25, -0.3], n: 6870 },
  { name: 'SAP', ic: 'S', bg: '#3a4f9e', c: [1.75, -1.15, 0.4], n: 4120 },
]
const GN_PER = 30, GN = CL.length * GN_PER
const GNODES = []
{
  const r = rng(21)
  CL.forEach((cl, ci) => {
    for (let j = 0; j < GN_PER; j++) {
      const th = r() * Math.PI * 2, ph = Math.acos(2 * r() - 1), rad = 0.3 + r() * 0.75
      GNODES.push({ ci, p: [cl.c[0] + rad * Math.sin(ph) * Math.cos(th), cl.c[1] + rad * Math.cos(ph) * 0.8, cl.c[2] + rad * Math.sin(ph) * Math.sin(th)], at: 32.1 + (j / GN_PER) * 6.0 + r() * 0.25 + ci * 0.07, s: r() })
    }
  })
}
const gpts = makePoints(GN, pointsMat())
graph.add(gpts)
GNODES.forEach((n, i) => {
  gpts.geometry.attributes.position.setXYZ(i, ...n.p)
  const c = PAL[i % 4]
  gpts.geometry.attributes.tint.setXYZ(i, c.r, c.g, c.b)
  gpts.geometry.attributes.size.setX(i, 0.06 + n.s * 0.06)
})
gpts.geometry.attributes.position.needsUpdate = true
const hubMat = new THREE.MeshStandardMaterial({ color: 0xd2bdf5, emissive: 0xb38de8, emissiveIntensity: 0.9, roughness: 0.4, transparent: true })
CL.forEach((cl) => {
  cl.mesh = new THREE.Mesh(new THREE.SphereGeometry(0.13, 32, 24), hubMat)
  cl.mesh.position.fromArray(cl.c)
  cl.glow = glowSprite(0xb38de8, 1.3, 0.6)
  cl.mesh.add(cl.glow)
  graph.add(cl.mesh)
  cl.label = add(FX, `<div class="cl">${cl.name}<small>0 events</small></div>`)
  cl.count = cl.label.querySelector('small')
})
// Links: hub → ghost, node → hub, and a few cross links between apps; drawn in order of appearance.
const SEGS = []
CL.forEach((cl) => SEGS.push([[0, 0, 0], cl.c, 32.0]))
GNODES.forEach((n) => SEGS.push([n.p, CL[n.ci].c, n.at]))
{
  const r = rng(44)
  for (let k = 0; k < 18; k++) {
    const a = GNODES[(r() * GN) | 0], b = GNODES[(r() * GN) | 0]
    if (a.ci !== b.ci) SEGS.push([a.p, b.p, Math.max(a.at, b.at) + 0.3])
  }
}
SEGS.sort((x, y) => x[2] - y[2])
const linkGeo = new THREE.BufferGeometry()
linkGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SEGS.flatMap(([a, b]) => [...a, ...b])), 3))
const linkMat2 = glowBlend(new THREE.LineBasicMaterial({ color: 0xc9b2f2, opacity: 0.3 }))
const links = new THREE.LineSegments(linkGeo, linkMat2)
links.frustumCulled = false
graph.add(links)

const kb = add(FX, `<div class="kb glass">
  <div class="hd"><b>Knowledge base</b><span class="mo">Jan</span></div>
  ${CL.map((c) => `<div class="ap"><div class="ic" style="background:${c.bg}">${c.ic}</div><div class="nm">${c.name}</div><div class="n">0</div><div class="ln"><i></i></div></div>`).join('')}
  <div class="stat"><div><b class="h">0</b><span>habits learned</span></div><div><b class="w">0</b><span>workflows</span></div><div><b>4</b><span>experts</span></div></div>
  <div class="ready"><div class="t">Ready to teach · Accounts payable<b>0%</b></div><div class="ln"><i></i></div><div class="ok">✓ Ready to onboard new hires</div></div>
  <div class="foot">App Profiles refresh every 10 active minutes · masked, stored locally</div>
</div>`)
const kbMo = kb.querySelector('.mo'), kbAps = [...kb.querySelectorAll('.ap')], kbH = kb.querySelector('.h'), kbW = kb.querySelector('.w')
const kbReady = kb.querySelector('.ready'), kbPct = kbReady.querySelector('.t b'), kbBar = kbReady.querySelector('.ln i'), kbOk = kbReady.querySelector('.ok')
const fmt = (n) => Math.round(n).toLocaleString('en-US')

// ------------------------------------------------------------------ DOM: scene 5, guided pointing
const ringB = add(B.win, '<div class="hring"></div>')
const pinB = add(B.win, '<div class="pinlab">Sabine clicked here · step 4 · on 212 invoices</div>')
const mineB = add(B.win, '<div class="mine">Jonas · new hire</div>')
const toastB = add(B.win, '<div class="toast">✓ PO-20417 matched · ready to post</div>')
{
  const r = rectOf(B, 'matchpo')
  Object.assign(ringB.style, { left: `${r.x - 8}px`, top: `${r.y - 8}px`, width: `${r.w + 16}px`, height: `${r.h + 16}px` })
  Object.assign(pinB.style, { left: `${r.cx}px`, top: `${r.y + r.h + 16}px` })
  const p = rectOf(B, 'post')
  Object.assign(toastB.style, { position: 'absolute', left: `${p.x + p.w - 430}px`, top: `${p.y + 58}px`, zIndex: 18 })
}
const chain = add(TY, `<div class="chain">
  <span class="pc">brain:locate(<em>"Match PO"</em>)</span><span class="ar">→</span>
  <span class="pc">observer:tree → <em>UIA rect</em></span><span class="ar">→</span>
  <span class="pc">displays:toDip</span><span class="ar">→</span>
  <span class="pc">overlay · <em>highlight</em></span></div>`)
const chainC = [...chain.querySelectorAll('.pc')], chainA = [...chain.querySelectorAll('.ar')]
const code = add(FX, `<div class="code glass"><div class="k">Overlay window · Electron</div>
  <pre>overlay.<b>setIgnoreMouseEvents</b>(<i>true</i>,
  { forward: <i>true</i> })</pre>
  <div class="t">Click-through. It points; it never moves your mouse or clicks for you.</div></div>`)

const bG1 = bubble('ghost', 'Protégé', '“This one. Sabine always matches the PO first.”')

// ------------------------------------------------------------------ the timeline
function cameraAt(t) {
  if (t >= 53.5) return { p: [0, 0.2, track([[53.5, 11.6], [59, 10.2]], t, E.sine)], look: [0, 0.2, 0] }
  return { p: [0, 0, 10], look: [0, 0, 0] }
}

// Ghost state per time: position (world), scale, rotation, visibility, speed-line strength and trail direction.
function ghostAt(t) {
  const bob = Math.sin(t * 2.1) * 0.06
  if (t < 21.1) return { on: false }
  if (t < 31.6) {
    const k = E.out(prog(t, 21.2, 22.3))
    const mv = E.inOut(prog(t, 30.8, 31.6))
    return { on: true, p: [lerp(0, -1.6, mv), -0.15 + bob + (1 - k) * 0.6, 0], s: lerp(0.48, 0.32, mv), ry: Math.sin(t * 0.5) * 0.22, rz: 0, mat: k }
  }
  if (t < 40.2) {
    const out = E.in(prog(t, 39.3, 39.95))
    return { on: true, p: [-1.6 + out * 7, bob + out * 4.2, 0], s: 0.32, ry: Math.sin(t * 0.5) * 0.22 - out * 0.5, rz: -out * 0.5, speed: out * 1.5, dir: Math.PI * 0.75 }
  }
  if (t < 53.5) {
    if (t < 43.4) return { on: false }
    const r = screenRect(B.fields.matchpo)
    const kin = E.inOut(prog(t, 43.45, 44.4))
    let sx = lerp(2100, r.cx - 40, kin), sy = lerp(-80, r.y - 112, kin) - Math.sin(kin * Math.PI) * 120
    const out = E.in(prog(t, 52.9, 53.5))
    sx += out * 700; sy -= out * 600
    const w = screenToWorld(sx, sy)
    const spin = E.inOut(prog(t, 50.9, 51.7)) * Math.PI * 2, hop = Math.sin(prog(t, 50.9, 51.7) * Math.PI) * 0.3
    return { on: true, p: [w.x, w.y + bob * 0.5 + hop, 0], s: 0.27, ry: -0.5 + spin + Math.sin(t * 0.7) * 0.1, rz: -0.3 * Math.sin(kin * Math.PI),
      speed: Math.sin(kin * Math.PI) + out, dir: out > 0 ? Math.PI * 0.75 : -0.45 }
  }
  const k = E.out(prog(t, 53.6, 54.5))
  return { on: true, p: [0, 1.3 + bob + (1 - k) * 0.8, 0], s: 0.48, ry: Math.sin(t * 0.45) * 0.2, rz: 0, mat: k }
}

function seek(t) {
  t = clamp(t, 0, DURATION)
  const frame = Math.round(t * 30)
  const L = Object.fromEntries(LINES.map((l) => [l.id, l]))

  // ---- windows first: the ghost and labels read their on-screen rects in this same frame
  {
    const kin = E.out(prog(t, 8.7, 9.9)), kout = E.in(prog(t, 20.5, 21.1))
    setWin(A, {
      cx: 640 - (1 - kin) * 200 - kout * 150, cy: 560 + (1 - kin) * 80, s: 0.62 * (0.8 + 0.2 * kin) + kout * 0.1,
      rx: 4 + (1 - kin) * 14 + drift(t, 4) * 0.3, ry: 14 + (1 - kin) * 20 + drift(t, 7) * 0.4, rz: (1 - kin) * -3,
      z: -(1 - kin) * 400, o: t > 8.6 && t < 21.2 ? E.out(prog(t, 8.7, 9.4)) * (1 - kout) : 0, filter: kout > 0 ? `blur(${kout * 16}px)` : 'none',
    })
  }
  {
    const kin = E.out(prog(t, 40.2, 41.4)), kout = E.in(prog(t, 52.9, 53.5))
    setWin(B, {
      cx: 860 + (1 - kin) * 260, cy: 560 + (1 - kin) * 80, s: 0.72 * (0.8 + 0.2 * kin) + kout * 0.08,
      rx: 4 + (1 - kin) * 12 + drift(t, 5) * 0.3, ry: -7 - (1 - kin) * 22 + drift(t, 8) * 0.4, rz: (1 - kin) * 3,
      z: -(1 - kin) * 400, o: t > 40.1 && t < 53.6 ? E.out(prog(t, 40.2, 40.9)) * (1 - kout) : 0, filter: kout > 0 ? `blur(${kout * 16}px)` : 'none',
    })
  }

  // ---- camera with a little handheld drift
  const cam = cameraAt(t)
  camera.position.set(cam.p[0] + drift(t, 1) * 0.04, cam.p[1] + drift(t, 2) * 0.03, cam.p[2])
  camera.lookAt(...cam.look)
  camera.updateMatrixWorld()

  // ---- background aura
  $('bg').querySelectorAll('.aura').forEach((a, i) => {
    a.style.opacity = 0.75 * (0.8 + 0.2 * Math.sin(t * 0.4 + i * 2))
    a.style.transform = `translate(${drift(t * 0.3, i * 3) * 60}px, ${drift(t * 0.25, i * 5 + 1) * 40}px)`
  })

  // ---- ghost
  const g = ghostAt(t)
  ghost.visible = !!g.on
  const speak = voiceAmp(t, L.g1)
  if (g.on) {
    ghost.position.fromArray(g.p)
    ghost.scale.setScalar(g.s * (1 + speak * 0.03))
    ghost.rotation.set(0, g.ry || 0, g.rz || 0)
    ghostBody.scale.set(1 + speak * 0.03, 1 - speak * 0.02, 1)
    updateGhostGeo(t * 2.2)
    const mat = g.mat === undefined ? 1 : g.mat
    ghostMat.transparent = mat < 1
    ghostMat.opacity = mat
    ghostMat.userData.glow.value = 0.38 + speak * 0.22 + (1 - mat) * 0.8
    ghostHalo.material.opacity = 0.5 * mat + speak * 0.3
    ghostHalo2.material.opacity = 0.3 * mat
    floor.visible = (t > 21 && t < 31) || t >= 53.5
    floor.material.opacity = 0.6 * mat
    const blink = [23.4, 27.9, 34.2, 37.6, 46.2, 49.8, 55.6, 57.9].some((b) => t > b && t < b + 0.14) ? 0.12 : 1
    eyes.forEach((e) => { e.scale.y = 0.175 * blink })
  }
  if (g.on && g.speed > 0.15) {
    const sp = toScreen(ghost.position)
    op(speed, clamp(g.speed) * 0.9)
    speed.style.transform = `translate(${sp.x - 310}px, ${sp.y - 45}px) rotate(${(g.dir || 0) + Math.PI}rad)`
    speed.style.transformOrigin = '310px 45px'
  } else op(speed, 0)

  // bubbles: the end card
  const bubA = env(t, 53.7, 60, 1.0, 0.1)
  bubbles.visible = bubA > 0.01
  if (bubbles.visible) {
    bubbles.position.copy(ghost.position)
    bubbleMat.uniforms.uT.value = t
    bubbles.children.forEach((b, i) => {
      const [x, y, z, r] = b.userData.base
      const pop = E.back(prog(t, 53.8 + i * 0.09, 54.4 + i * 0.09))
      b.position.set(x * 1.35, y * 0.7 + Math.sin(t * 0.9 + i * 1.7) * 0.15, z)
      b.scale.setScalar(Math.max(0.0001, r * clamp(pop) * 0.85))
    })
  }

  // dust, streams, knowledge graph
  updateDust(t, Math.max(0.3, env(t, 21, 40.2, 0.8, 0.6), env(t, 53.4, 59, 0.6, 0.3)))
  updateStreams(t, env(t, 22.0, 31.0, 0.8, 0.6), ghost.position)
  const graphA = env(t, 31.5, 40.0, 0.5, 0.6)
  graph.visible = graphA > 0.001
  if (graph.visible) {
    graph.position.set(-1.6, Math.sin(t * 2.1) * 0.03, 0)
    graph.rotation.set(0.12, -0.3 + (t - 31.5) * 0.09, 0)
    graph.updateMatrixWorld(true)
    const AL = gpts.geometry.attributes.alpha
    GNODES.forEach((n, i) => AL.setX(i, graphA * E.out(prog(t, n.at, n.at + 0.4)) * (0.65 + 0.35 * Math.sin(t * 2 + i))))
    AL.needsUpdate = true
    links.geometry.setDrawRange(0, 2 * SEGS.filter((sg) => sg[2] <= t).length)
    linkMat2.opacity = 0.3 * graphA
    hubMat.opacity = graphA
    CL.forEach((cl, i) => {
      const a = E.back(prog(t, 31.9 + i * 0.12, 32.5 + i * 0.12))
      cl.mesh.scale.setScalar(Math.max(0.0001, clamp(a)))
      cl.glow.material.opacity = 0.6 * graphA
    })
  }

  renderer.render(scene, camera)

  // ================================================================ DOM layers
  // ---- scene 1: one recorded hour vs a year
  {
    op(year, env(t, 0.4, 8.7, 0.6, 0.5))
    year.style.filter = t > 8.1 ? `blur(${E.in(prog(t, 8.1, 8.7)) * 14}px)` : 'none'
    year.style.transform = `translateY(${(1 - E.out(prog(t, 0.4, 1.4))) * 30}px)`
    const fill = E.inOut(prog(t, 6.9, 8.1)), fx = fill * YW
    yFill.style.width = `${fx}px`
    op(yFill, fill > 0 ? 1 : 0)
    const rk = E.back(prog(t, 0.9, 1.3))
    yRec.style.transform = `scale(${clamp(rk, 0, 1.4)})`
    op(yRec, clamp(rk))
    op(yRecLab, E.out(prog(t, 1.2, 1.6)))
    DOTS.forEach((d) => {
      const at = d.got ? 1.3 : 1.5 + (d.x / YW) * 1.6
      const p = E.back(prog(t, at, at + 0.35))
      const lost = !d.got ? E.inOut(prog(t, 4.4 + (d.x / YW) * 1.0, 4.9 + (d.x / YW) * 1.0)) * (fx > d.x ? 0 : 1) : 0
      d.n.style.transform = `scale(${clamp(p, 0, 1.3) * (d.key ? 1.25 : 1)})`
      op(d.n, clamp(p) * (1 - lost * 0.75))
      d.n.style.filter = lost > 0.01 ? `grayscale(${lost})` : 'none'
    })
    HL.forEach((h, j) => {
      const a = E.out(prog(t, 2.4 + j * 0.35, 2.9 + j * 0.35))
      op(h.n, a)
      const k = E.inOut(prog(t, 4.6 + j * 0.3, 5.0 + j * 0.3)) * (fx > h.x ? 0 : 1)
      h.x_.style.transform = `scaleX(${k})`
      op(h.lost, k)
      h.n.style.color = `rgba(245,243,251,${1 - k * 0.45})`
    })
    op(yCap, E.out(prog(t, 7.4, 7.9)))
    charReveal(chars.gapO, t, 0.6, { stagger: 0.02, dur: 0.6, rise: 10, blur: 6, out: 8.0, outDur: 0.4, outStagger: 0.005 })
    op(T.gapO, t < 8.6 ? 1 : 0)
    charReveal(chars.gap1, t, 1.0, { out: 3.9, outDur: 0.5 })
    op(T.gap1, t < 4.6 ? 1 : 0)
    charReveal(chars.gap2, t, 4.2, { out: 6.6, outDur: 0.5, scatter: true })
    op(T.gap2, t > 4.1 && t < 7.4 ? 1 : 0)
    charReveal(chars.gap3, t, 7.0, { stagger: 0.02, out: 8.1, outDur: 0.45 })
    op(T.gap3, t > 6.9 && t < 8.7 ? 1 : 0)
  }

  // ---- corner labels
  const cornerA = (el, t0, t1) => { const c = E.out(prog(t, t0, t0 + 0.5)) * (1 - E.in(prog(t, t1 - 0.4, t1))); op(el, c); el.style.transform = `translateX(${(1 - c) * -24}px)` }
  cornerA(T.co1, 9.0, 21.0); cornerA(T.co2, 21.4, 31.4); cornerA(T.co3, 31.8, 39.9); cornerA(T.co4, 40.5, 53.4)

  // ---- scene 2: Windows UI Automation
  {
    const vis = t > 8.6 && t < 21.2
    if (vis) {
      const ks = prog(t, 9.4, 11.3)
      const beamY = lerp(-160, 900, E.sine(ks))
      op(A.scan, ks > 0 && ks < 1 ? Math.sin(ks * Math.PI) * 0.95 + 0.05 : 0)
      A.scan.style.transform = `translateY(${beamY}px)`
      TAGS.forEach(({ n, r, f }) => {
        const hit = ks > 0 && beamY + 160 > r.y ? 1 : 0
        const keep = f === 'sup' || f === 'amt' ? 1 - prog(t, 13.6, 14.0) : 1
        op(n, hit * keep)
      })
      const cc = rectOf(A, 'cc'), post = rectOf(A, 'post')
      const path = [[13.4, [1180, 800]], [14.85, [cc.x + 120, cc.cy]], [15.9, [cc.x + 130, cc.cy + 6]], [16.7, [cc.x + 260, cc.cy + 70]], [18.6, [post.cx - 140, post.cy - 70]], [19.35, [post.cx, post.cy]], [21, [post.cx + 10, post.cy + 20]]]
      setCursor(A, path, t, [14.9, 19.4])
      op(A.cursor, E.out(prog(t, 13.2, 13.6)))
      A.fields.cc.classList.toggle('focus', t > 14.9 && t < 16.2)
      const typed = '0400'.slice(0, Math.floor(clamp((t - 15.25) / 0.55) * 4 + 0.0001))
      if (t < 14.95) setVal(A, 'cc', '6100')
      else if (t < 15.25) setVal(A, 'cc', '<span style="background:#b5d7ff">6100</span>')
      else setVal(A, 'cc', typed + (t < 16.2 && Math.floor(t * 3) % 2 === 0 ? '<span class="caret"></span>' : ''))
      A.fields.post.style.transform = t > 19.4 && t < 19.6 ? 'scale(0.95)' : 'none'
    }
    // tree panel
    const tk = E.out(prog(t, 9.6, 10.3)), tout = E.in(prog(t, 20.5, 21.1))
    op(tree, vis ? tk * (1 - tout) : 0)
    place(tree, 1170 + (1 - tk) * 80 + tout * 60, 120, `perspective(1400px) rotateY(${-8 + (1 - tk) * -14}deg)`)
    trows.forEach((rw, i) => {
      const a = E.out(prog(t, TREE_T[i], TREE_T[i] + 0.3))
      op(rw, a)
      rw.style.transform = `translateX(${(1 - a) * 16}px)`
    })
    const vl = (i) => trows[i].querySelector('.vl')
    const setT = (i, h) => { if (vl(i).innerHTML !== h) vl(i).innerHTML = h }
    setT(4, t < 15.85 ? '6100' : '0400')
    setT(5, t < 16.95 ? 'DE89 3704 0044 …' : 'DE•• •••• 3000 · masked')
    vl(5).classList.toggle('m', t >= 16.95)
    trows[4].classList.toggle('flash', t > 15.85 && t < 16.6)
    trows[5].classList.toggle('flash', t > 16.95 && t < 17.7)
    trows[6].classList.toggle('flash', t > 19.45 && t < 20.2)
    trows[7].classList.toggle('flash', t > 12.5 && t < 13.2)
    // event stream
    const ek = E.out(prog(t, 13.9, 14.5))
    op(events, vis ? ek * (1 - tout) : 0)
    place(events, 1170 + (1 - ek) * 80 + tout * 60, 540, `perspective(1400px) rotateY(${-8 + (1 - ek) * -14}deg)`)
    evs.forEach((n, i) => { const a = E.out(prog(t, EVENTS[i][0], EVENTS[i][0] + 0.3)); op(n, a); n.style.transform = `translateY(${(1 - a) * 10}px)` })
    // pipeline
    const pk = E.out(prog(t, 13.6, 14.2))
    op(pipe, vis ? pk * (1 - tout) : 0)
    place(pipe, 205, 905 + (1 - pk) * 16)
    pipeC.forEach((c, i) => c.classList.toggle('on', t > 17.5 + i * 0.4))
  }

  // ---- scene 3: always on, every expert
  {
    const kout = E.in(prog(t, 30.8, 31.5))
    EXPERTS.forEach((e, i) => {
      const a = E.out(prog(t, 21.5 + i * 0.25, 22.2 + i * 0.25)) * (1 - kout)
      op(e.n, a)
      place(e.n, e.x + (1 - a) * (e.x < 900 ? -40 : 40), e.y + Math.sin(t * 1.2 + i) * 4)
      if (a > 0) {
        const H = e.lines.length * 28, off = (t - 21) * e.sp
        e.lines.forEach((ln, j) => {
          const y = 84 - ((((off + (e.lines.length - j) * 28) % H) + H) % H)
          ln.style.transform = `translateY(${y}px)`
          ln.style.opacity = clamp(Math.min((y + 28) / 28, (84 - y) / 20))
        })
      }
    })
    const ca = env(t, 21.8, 31.3, 0.5, 0.5)
    op(counter, ca)
    const day = 1 + Math.floor(364 * E.inOut(prog(t, 22.2, 30.6)))
    counterD.textContent = `DAY ${String(day).padStart(3, '0')}`
    counterBar.style.width = `${(day / 365) * 100}%`
    op(T.always, env(t, 24.4, 31.2, 0.5, 0.5))
    T.always.style.transform = `translateY(${(1 - E.out(prog(t, 24.4, 24.9))) * 16}px)`
    const gp = ghost.visible ? toScreen(ghost.position) : { x: 960, y: 540 }
    HABITS.forEach((h, i) => {
      const a = E.back(prog(t, 28.0 + i * 0.55, 28.45 + i * 0.55))
      const suck = E.in(prog(t, 30.7 + i * 0.08, 31.3 + i * 0.08))
      op(h.n, clamp(a) * (1 - suck))
      h.n.style.transform = `translate(${lerp(h.x, gp.x, suck)}px, ${lerp(h.y, gp.y, suck) + Math.sin(t * 1.4 + i) * 3}px) translate(-50%, -50%) scale(${clamp(a, 0, 1.2) * (1 - suck * 0.6)})`
    })
  }

  // ---- scene 4: the knowledge base keeps growing
  {
    const grow = E.inOut(prog(t, 32.0, 38.6))
    CL.forEach((cl, i) => {
      const a = graph.visible ? E.out(prog(t, 32.3 + i * 0.15, 32.8 + i * 0.15)) * (1 - E.in(prog(t, 39.3, 39.9))) : 0
      op(cl.label, a)
      if (a > 0) {
        const v = new THREE.Vector3()
        cl.mesh.getWorldPosition(v)
        const sp = toScreen(v)
        cl.label.style.transform = `translate(${sp.x}px, ${sp.y - 46}px) translate(-50%, -50%)`
        cl.count.textContent = `${fmt(cl.n * grow)} events`
      }
    })
    const kin = E.out(prog(t, 31.9, 32.7)), kout = E.in(prog(t, 39.3, 39.95))
    op(kb, kin * (1 - kout))
    place(kb, 1260 + (1 - kin) * 80 + kout * 60, 180, `perspective(1400px) rotateY(${-10 + (1 - kin) * -14}deg)`)
    kb.style.filter = kout > 0 ? `blur(${kout * 12}px)` : 'none'
    if (kin > 0) {
      kbMo.textContent = MONTHS[Math.min(11, Math.floor(grow * 12))]
      kbAps.forEach((ap, i) => {
        const k = E.inOut(prog(t, 32.2 + i * 0.25, 38.6))
        ap.querySelector('.n').textContent = fmt(CL[i].n * k)
        ap.querySelector('.ln i').style.width = `${(CL[i].n / 18420) * 100 * k}%`
      })
      kbH.textContent = fmt(312 * grow)
      kbW.textContent = fmt(27 * grow)
      const rd = E.inOut(prog(t, 32.3, 37.9))
      kbPct.textContent = `${Math.round(96 * rd)}%`
      kbBar.style.width = `${96 * rd}%`
      kbReady.classList.toggle('done', t > 38.0)
      op(kbOk, E.out(prog(t, 38.0, 38.4)))
    }
  }

  // ---- scene 5: guided pointing
  {
    const vis = t > 40.1 && t < 53.6
    if (vis) {
      const desc = rectOf(B, 'desc'), amt = rectOf(B, 'amt'), pon = rectOf(B, 'pon'), cc = rectOf(B, 'cc'), btn = rectOf(B, 'matchpo')
      const path = [[40.4, [760, 760]], [41.55, [desc.x + 240, desc.cy]], [42.2, [amt.x + 140, amt.cy]], [42.85, [pon.x + 110, pon.cy]], [43.9, [cc.x + 220, cc.cy + 14]],
        [45.5, [cc.x + 190, cc.cy + 30]], [47.5, [cc.x + 250, cc.cy + 12]], [49.2, [cc.x + 230, cc.cy + 22]], [50.5, [btn.cx, btn.cy], E.inOut], [53.4, [btn.cx + 20, btn.cy + 30]]]
      setCursor(B, path, t, [41.6, 42.9, 50.6])
      const [cx, cy] = track(path, t)
      place(mineB, cx + 26, cy + 26)
      const mineTxt = t < 48.4 ? 'Jonas · new hire' : 'Jonas’s mouse · Jonas’s click'
      if (mineB.textContent !== mineTxt) mineB.textContent = mineTxt
      op(mineB, E.out(prog(t, 40.9, 41.3)) * (1 - E.in(prog(t, 52.6, 53.0))))
      B.fields.pon.classList.toggle('focus', t > 42.9 && t < 43.8)
      setVal(B, 'pon', t < 50.7 ? '<span class="ph">Not matched yet</span>' : 'PO-20417 · matched')
      const ra = env(t, 44.85, 53.0, 0.25, 0.4)
      op(ringB, ra)
      ringB.classList.toggle('ok', t > 50.6)
      ringB.style.transform = `scale(${1 + (t < 50.6 ? 0.05 * Math.sin(t * 6) : 0.015 * Math.sin(t * 4))})`
      op(pinB, env(t, 45.0, 50.6, 0.35, 0.3))
      B.fields.matchpo.style.transform = t > 50.6 && t < 50.8 ? 'scale(0.95)' : 'none'
      const ta = env(t, 50.8, 53.0, 0.3, 0.4)
      op(toastB, ta)
      toastB.style.transform = `translateY(${(1 - E.out(prog(t, 50.8, 51.2))) * 14}px)`
    }
    const cOut = E.in(prog(t, 52.8, 53.4))
    chainC.forEach((c, i) => {
      const t0 = 45.6 + i * 0.7
      op(c, E.out(prog(t, t0, t0 + 0.3)) * (1 - cOut))
      c.classList.toggle('on', t > t0 && t < t0 + 0.7 + (i === 3 ? 10 : 0))
      if (i) op(chainA[i - 1], E.out(prog(t, t0 - 0.1, t0 + 0.2)) * (1 - cOut))
    })
    const kk = E.out(prog(t, 48.3, 48.9))
    op(code, kk * (1 - E.in(prog(t, 52.8, 53.4))))
    place(code, 1420 + (1 - kk) * 60, 250, `perspective(1400px) rotateY(${-10 + (1 - kk) * -14}deg)`)
    const gp = ghost.visible ? toScreen(ghost.position) : { x: 0, y: 0 }
    setBubble(bG1, gp.x - 640, gp.y - 130, t > 40 && t < 53.5 ? env(t, 44.15, 47.9, 0.3, 0.4) : 0, t, L.g1, 0.92)
  }

  // ---- scene 6: end card
  {
    const a = E.out(prog(t, 53.9, 55.0))
    op(T.endMark, a)
    const wipe = E.out(prog(t, 53.8, 55.0))
    T.endMark.style.clipPath = `inset(0 ${(1 - wipe) * 50}% 0 ${(1 - wipe) * 50}%)`
    T.endMark.style.filter = `blur(${((1 - E.out(prog(t, 53.8, 54.8))) * 20).toFixed(1)}px)`
    T.endMark.style.transform = `scale(${1.1 - 0.1 * E.out(prog(t, 53.8, 58))}) translateY(-30px)`
    charReveal(chars.endTag, t, 55.0, { stagger: 0.018, rise: 20, blur: 8 })
    op(T.endTag, t > 54.9 ? 1 : 0)
    T.endTag.style.transform = 'translateY(-55px)'
    const pa = E.out(prog(t, 56.0, 56.6))
    op(T.endPills, pa); T.endPills.style.transform = `translateY(${-62 + (1 - pa) * 16}px)`
    op(T.credit, E.out(prog(t, 56.5, 57.1)) * 0.85); T.credit.style.transform = 'translateY(-62px)'
  }

  // ---- post: letterbox, flashes, leaks, grain, fade
  const bars = E.inOut(prog(t, 53.2, 54.0))
  $('barTop').style.transform = `translateY(${-(1 - bars) * 140}px)`
  $('barBot').style.transform = `translateY(${(1 - bars) * 140}px)`
  const fl = Math.max(0.8 * Math.exp(-Math.max(0, t - 53.85) * 3) * (t > 53.7 ? 1 : 0) * E.out(prog(t, 53.7, 53.85)), 0.25 * Math.exp(-Math.max(0, t - 44.85) * 6) * (t > 44.85 ? 1 : 0))
  $('flash').style.opacity = fl * 0.85
  const flare = env(t, 53.8, 55.6, 0.12, 1.3) * 0.8
  $('flare').style.opacity = flare
  $('flare').style.transform = `scaleX(${0.6 + flare * 0.6}) translateY(90px)`
  const leak = (el, t0, dir) => {
    const k = prog(t, t0 - 0.5, t0 + 0.9)
    el.style.opacity = Math.sin(k * Math.PI) * 0.7
    el.style.transform = `translate(${lerp(-900, 1500, k) * dir + (dir < 0 ? 1400 : 0)}px, ${-200 + Math.sin(k * 3) * 100}px)`
  }
  const leaks = [8.5, 21.0, 31.4, 39.9, 53.4]
  const nearest = leaks.reduce((b, x) => (Math.abs(t - x) < Math.abs(t - b) ? x : b), leaks[0])
  leak($('leak1'), nearest, 1)
  leak($('leak2'), nearest + 0.15, -1)
  grainEl.style.backgroundImage = grainTex[frame % grainTex.length]
  const gr = rng(frame + 1)
  grainEl.style.transform = `translate(${(gr() * 200) | 0}px, ${(gr() * 200) | 0}px)`
  $('fade').style.opacity = Math.max(1 - E.out(prog(t, 0, 0.8)), E.in(prog(t, 58.1, 59)))
}

// ------------------------------------------------------------------ boot
async function boot() {
  await document.fonts.ready
  seek(0)
  window.ready = true
}
window.seek = (t) => { seek(t); return true }
window.DURATION = DURATION
boot()
