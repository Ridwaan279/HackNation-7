// Protégé demo film. Every frame is a pure function of time: render.mjs calls window.seek(t) and captures the page.
// Layers: #bg (aura) < #ui (app mockups, CSS 3D) < #gl (Three.js: ghost, orbs, particles, map) < #fx (bubbles, labels) < #type < #post.

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

// --- knowledge orbs (scene 1) and particle swarm (scenes 1-2) -------------------------
const ORBS = [
  { p: [-4.6, 1.7, -1.0], r: 0.34, c: C.sky, k: 'Coding', v: 'Equipment over €5k is capex' },
  { p: [-1.7, 2.5, -2.2], r: 0.26, c: C.lav, k: 'Approvals', v: 'Second sign-off above €10k' },
  { p: [1.9, 2.1, -1.2], r: 0.3, c: C.pink, k: 'Suppliers', v: 'Elbe often invoices twice' },
  { p: [4.7, 0.9, -1.6], r: 0.36, c: C.sky, k: 'Month-end', v: 'Cut-off is 3 pm, not 5' },
  { p: [-2.6, 0.1, 0.8], r: 0.24, c: C.pink, k: 'Guardrail', v: 'No asset number, no capex' },
  { p: [2.6, -0.1, 0.9], r: 0.27, c: C.lav, k: 'Bank details', v: 'New IBAN? Call to confirm' },
  { p: [0.1, 1.0, -3.4], r: 0.22, c: C.lav, k: '', v: '' },
  { p: [-5.6, -0.6, -3.4], r: 0.2, c: C.sky, k: '', v: '' },
]
const orbGroup = new THREE.Group()
scene.add(orbGroup)
const orbGeo = new THREE.SphereGeometry(1, 48, 32)
ORBS.forEach((o, i) => {
  const m = new THREE.Mesh(orbGeo, new THREE.MeshPhysicalMaterial({ color: o.c, emissive: o.c, emissiveIntensity: 0.55, roughness: 0.15, clearcoat: 1, envMapIntensity: 1.4 }))
  m.position.fromArray(o.p)
  m.scale.setScalar(o.r)
  const g = glowSprite(o.c, o.r * 7, 0.7)
  m.add(g)
  g.scale.setScalar(7)
  o.mesh = m
  orbGroup.add(m)
})
const LINKS = [[0, 1], [1, 2], [2, 3], [0, 4], [4, 6], [6, 2], [3, 5], [5, 7], [7, 4], [6, 1]]
const linkMat = new THREE.MeshBasicMaterial({ color: 0xc9b2f2, transparent: true, opacity: 0.35, toneMapped: false, depthWrite: false })
const linkMeshes = LINKS.map(([a, b]) => {
  const pa = new THREE.Vector3(...ORBS[a].p), pb = new THREE.Vector3(...ORBS[b].p)
  const mid = pa.clone().add(pb).multiplyScalar(0.5).add(new THREE.Vector3(0, 0.5, 0.3))
  const curve = new THREE.QuadraticBezierCurve3(pa, mid, pb)
  const m = new THREE.Mesh(new THREE.TubeGeometry(curve, 48, 0.012, 6), linkMat)
  orbGroup.add(m)
  return m
})

const SW_N = 5200
const swarm = makePoints(SW_N, pointsMat())
const SW = []
{
  const r = rng(42), v = new THREE.Vector3()
  const named = ORBS.length
  for (let i = 0; i < SW_N; i++) {
    const o = ORBS[i % named]
    const dir = new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize()
    const orb = new THREE.Vector3(...o.p).addScaledVector(dir, o.r * Math.cbrt(r()))
    const drift = orb.clone().addScaledVector(dir, 1.2 + r() * 3.2).add(new THREE.Vector3(0, 0.6 + r() * 1.6, 0))
    ghostPoint(r() * Math.PI * 2, 0.04 + r() * 0.94, 0, v)
    SW.push({ orb, drift, ghost: v.clone(), delay: r() * 0.9, spin: 1.5 + r() * 2.5 })
    const c = r() < 0.5 ? o.c : PAL[(r() * 4) | 0]
    swarm.geometry.attributes.tint.setXYZ(i, c.r, c.g, c.b)
    swarm.geometry.attributes.size.setX(i, 0.02 + r() * 0.05)
  }
}
const tmpV = new THREE.Vector3()
function updateSwarm(t) {
  const on = t > 5.2 && t < 12.6
  swarm.visible = on
  if (!on) return
  const P = swarm.geometry.attributes.position, A = swarm.geometry.attributes.alpha
  for (let i = 0; i < SW_N; i++) {
    const s = SW[i]
    const kd = E.out(prog(t, 5.4 + s.delay, 8.4 + s.delay * 0.5))
    const kc = E.inOut(prog(t, 8.5 + s.delay * 0.6, 11.15))
    tmpV.copy(s.orb).lerp(s.drift, kd)
    tmpV.y += Math.sin(t * 1.3 + i) * 0.08 * kd
    if (kc > 0) {
      const ang = (1 - kc) * s.spin
      tmpV.lerp(s.ghost, kc)
      const x = tmpV.x, z = tmpV.z
      tmpV.x = x * Math.cos(ang) - z * Math.sin(ang)
      tmpV.z = x * Math.sin(ang) + z * Math.cos(ang)
    }
    P.setXYZ(i, tmpV.x, tmpV.y, tmpV.z)
    const a = E.out(prog(t, 5.4 + s.delay, 5.9 + s.delay)) * (1 - prog(t, 11.15, 12.2)) * (0.55 + 0.45 * Math.sin(t * 3 + i))
    A.setX(i, a)
  }
  P.needsUpdate = true
  A.needsUpdate = true
}

// --- Work Map constellation (scene 4) -------------------------------------------------
const NODES = [
  { p: [-4.3, -0.7, 0.2], r: 0.36, c: C.sky },
  { p: [-1.5, 1.25, -0.8], r: 0.46, c: C.lav },
  { p: [1.25, -0.45, 0.6], r: 0.42, c: C.pink, ring: true },
  { p: [4.1, 1.0, -0.4], r: 0.36, c: C.sky },
]
const mapGroup = new THREE.Group()
scene.add(mapGroup)
NODES.forEach((n) => {
  const mat = n.ring
    ? new THREE.MeshPhysicalMaterial({ color: 0x281a33, roughness: 0.05, transparent: true, opacity: 0.55, iridescence: 1, clearcoat: 1, envMapIntensity: 2.2, emissive: n.c, emissiveIntensity: 0.25 })
    : new THREE.MeshPhysicalMaterial({ color: n.c, emissive: n.c, emissiveIntensity: 0.45, roughness: 0.15, clearcoat: 1, envMapIntensity: 1.4 })
  const m = new THREE.Mesh(orbGeo, mat)
  m.position.fromArray(n.p)
  const g = glowSprite(n.c, 6, 0.6)
  m.add(g)
  if (n.ring) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.55, 0.04, 12, 120), new THREE.MeshBasicMaterial({ color: 0xff9fe6, toneMapped: false }))
    ring.rotation.set(1.3, 0.2, 0)
    m.add(ring)
    n.ringMesh = ring
    const core = glowSprite(0xf59fdf, 2.4, 0.9)
    m.add(core)
  }
  n.mesh = m
  mapGroup.add(m)
})
const mapTubeMat = new THREE.MeshStandardMaterial({ color: 0xd2bdf5, emissive: 0xb38de8, emissiveIntensity: 0.6, roughness: 0.4 })
const mapTubes = []
for (let i = 0; i < NODES.length - 1; i++) {
  const a = new THREE.Vector3(...NODES[i].p), b = new THREE.Vector3(...NODES[i + 1].p)
  const mid = a.clone().add(b).multiplyScalar(0.5).add(new THREE.Vector3(0, 0.9, 0.4))
  const g = new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(a, mid, b), 80, 0.05, 10)
  const m = new THREE.Mesh(g, mapTubeMat)
  mapGroup.add(m)
  mapTubes.push(m)
}
// Faint background constellation for depth.
const mapStars = new THREE.Group()
{
  const r = rng(77)
  for (let i = 0; i < 14; i++) {
    const c = PAL[i % 3]
    const m = new THREE.Mesh(orbGeo, new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.5, toneMapped: false }))
    m.position.set(r() * 16 - 8, r() * 7 - 3.5, -4 - r() * 6)
    m.scale.setScalar(0.06 + r() * 0.1)
    m.add(glowSprite(c, 8, 0.35))
    mapStars.add(m)
  }
}
mapGroup.add(mapStars)

// --- trust shield (scene 6) ------------------------------------------------------
const shieldMat = glowBlend(new THREE.ShaderMaterial({
  uniforms: { uT: { value: 0 }, uA: { value: 0 } },
  vertexShader: `varying vec3 vN; varying vec3 vV; varying vec3 vP;
    void main(){ vP=position; vec4 mv=modelViewMatrix*vec4(position,1.0); vN=normalize(normalMatrix*normal); vV=normalize(-mv.xyz); gl_Position=projectionMatrix*mv; }`,
  fragmentShader: `varying vec3 vN; varying vec3 vV; varying vec3 vP; uniform float uT; uniform float uA;
    void main(){ float f=pow(1.0-abs(dot(vN,vV)),2.4);
      float hex=abs(sin(vP.x*9.0+uT*0.6)*sin(vP.y*9.0)*sin(vP.z*9.0-uT*0.4));
      float scan=smoothstep(0.96,1.0,sin(vP.y*3.0-uT*2.2));
      vec3 c=mix(vec3(0.49,0.78,0.96),vec3(0.96,0.62,0.87),vP.y*0.25+0.5);
      float a=(f*0.95+smoothstep(0.92,1.0,hex)*0.18+scan*0.25)*uA;
      gl_FragColor=vec4(c*1.3,a); }`,
}))
const shield = new THREE.Mesh(new THREE.IcosahedronGeometry(2.25, 6), shieldMat)
scene.add(shield)

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

// ------------------------------------------------------------------ DOM: titles
function title(html, top, cls = '') { return add(TY, `<div class="title ${cls}" style="top:${top}px">${html}</div>`) }
const T = {}
T.loss1o = title('<div class="overline">Sabine · Accounts payable</div>', 742)
T.loss1 = title('<div class="big">24 years of knowing <span class="serif">why.</span></div>', 776)
T.loss2 = title('<div class="big">18 months until she <span class="serif">retires.</span></div>', 776)
T.brand = title('<div class="big serif grad" style="font-size:180px;line-height:1.05;letter-spacing:-0.01em;">Protégé</div>', 690)
T.brandSub = title('<div class="overline" style="color:var(--ink-2)">AI onboarding that learns from your experts</div>', 905 - 50)
const chapter = (n, name) => add(TY, `<div class="chapter"><div class="num">${n}</div><div class="name"><span class="grad" style="padding:0 0.08em">${name}</span></div></div>`)
const corner = (n, name) => add(TY, `<div class="corner"><b>${n}</b><i></i>${name}</div>`)
T.ch1 = chapter('01', 'Capture'); T.co1 = corner('01', 'Capture')
T.ch2 = chapter('02', 'Map'); T.co2 = corner('02', 'Map')
T.ch3 = chapter('03', 'Teach'); T.co3 = corner('03', 'Teach')
T.trust1 = title('<div class="big" style="font-size:72px">Never reads a <span class="serif">password.</span></div>', 86)
T.trust2 = title('<div class="big" style="font-size:72px">Keeps learning. <span class="serif">Every app, every day.</span></div>', 86)
T.endMark = title('<div class="endmark"><span class="grad">Protégé</span></div>', 560)
T.endTag = title('<div class="mid">Show it once. <span class="serif" style="color:var(--ink)">Protégé remembers.</span></div>', 800)
T.endPills = title('<div class="pills"><span class="chip mono">01 Capture</span><span class="chip mono">02 Map</span><span class="chip mono">03 Teach</span></div>', 872)
T.credit = title('<div class="overline" style="font-size:13px">Built at Hack-Nation × ElevenLabs · Windows desktop + web</div>', 960)

const chars = {
  loss1o: splitChars(T.loss1o), loss1: splitChars(T.loss1), loss2: splitChars(T.loss2),
  trust1: splitChars(T.trust1), trust2: splitChars(T.trust2), endTag: splitChars(T.endTag),
}

// ------------------------------------------------------------------ DOM: orb labels (scene 1)
ORBS.forEach((o) => { if (o.k) o.label = add(FX, `<div class="olabel"><small>${o.k}</small>${o.v}</div>`) })

// ------------------------------------------------------------------ DOM: MiniERP windows
const CURSOR = '<svg class="cursor" viewBox="0 0 24 24"><path d="M3 2l15 10.5-6.6 1.3 3.8 7.3-3 1.5-3.8-7.4L3 20z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>'
function erp(o) {
  const list = o.list.map((x, i) => `<div class="inv ${i === 0 ? 'on' : ''}">${x[0]}<b>${x[1]}</b><span class="amt">${x[2]}</span><span class="st">Pending</span></div>`).join('')
  const f = (id, label, val, cls = '', hint = '') =>
    `<div class="f ${cls}"><label>${label}</label><div class="in ${cls.includes('sel') ? 'sel' : ''}" data-f="${id}"><span class="v">${val}</span></div>${hint ? `<div class="hint">${hint}</div>` : ''}${id === 'cc' ? '<div class="menu"><div data-o="6100">6100<span>Operating expense</span></div><div data-o="0400">0400<span>Capital expenditure</span></div></div>' : ''}</div>`
  return add(UI, `<div class="win" style="left:0;top:0">
    <div class="chrome"><span class="ico"></span>MiniERP · Finance workspace<span class="ctl"><span>—</span><span>▢</span><span>✕</span></span></div>
    <div class="addr"><span class="nav">← → ⟳</span><span class="url">minierp.local/accounts-payable/${o.id}</span></div>
    <div class="top"><span class="logo">MiniERP</span><span class="ws">Finance workspace</span><span class="demo">Local demo · Synthetic data</span><span class="av">${o.user}</span></div>
    <div class="page">
      <div class="eyebrow">ACCOUNTS PAYABLE</div><h1>Invoice inbox</h1><div class="sub">Review, code and route supplier invoices.</div>
      <div class="grid"><div class="list"><div class="hd">Invoices <span>${o.list.length} pending</span></div>${list}</div>
        <div class="detail"><div class="eyebrow">INVOICE DETAILS</div><h2>${o.id}</h2><span class="status">Pending</span>
          <div class="fields">
            ${f('sup', 'Supplier', o.list[0][1])}${f('amt', 'Amount (EUR)', o.amount)}
            ${f('desc', 'Description', o.desc, 'wide')}
            ${f('date', 'Invoice date', '10/04/2026')}${f('sub', 'Subsidiary', 'Germany', 'sel')}
            ${f('cc', 'Cost center', o.cc, 'sel', '6100 · Operating expense / 0400 · Capital expenditure')}${f('asset', 'Asset number', o.asset)}
            ${f('bank', 'Bank details', o.iban, 'wide')}
          </div>
          <div class="actions"><span class="btn">Save draft</span><span class="btn primary" data-f="post">Post invoice</span></div>
        </div></div>
    </div>
    <div class="dim"></div>
    <div class="scan"></div>
    <div class="ripple"></div><div class="ripple"></div>
    ${CURSOR}
  </div>`)
}
const winA = erp({
  id: 'INV-4471', user: 'S', amount: '6400.00', desc: 'Production equipment: milling unit', cc: '6100', asset: 'AS-2026-087',
  iban: 'DE89 3704 0044 0532 0130 00',
  list: [['INV-4471', 'Nordwerk Equipment', '€6,400.00'], ['INV-4472', 'Müller GmbH', '€1,850.00'], ['INV-4473', 'Brenner Components', '€2,390.00']],
})
const winB = erp({
  id: 'INV-5801', user: 'J', amount: '7200.00', desc: 'Production equipment: inspection station', cc: '<span class="ph">Select cost center</span>',
  asset: '<span class="ph">Enter asset reference</span>', iban: 'DE02 1203 0000 0000 2020 51',
  list: [['INV-5801', 'Elbe Industrial', '€7,200.00'], ['INV-5802', 'Bürobedarf West', '€240.00']],
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

// Field tags for the accessibility scan (capture).
const TAGS = [
  ['sup', 'Edit · Supplier'], ['amt', 'Edit · Amount (EUR)'], ['desc', 'Edit · Description'], ['cc', 'ComboBox · Cost center'], ['asset', 'Edit · Asset number'], ['bank', 'IBAN · masked', 'mask'],
].map(([f, text, cls]) => {
  const r = rectOf(A, f)
  const n = addTag(A, f, text, cls)
  n.style.left = `${r.x - 4}px`; n.style.top = `${r.y - 4}px`; n.style.width = `${r.w + 8}px`; n.style.height = `${r.h + 8}px`
  return { n, r, f }
})
const ringB = add(B.win, '<div class="ring"></div>')
{
  const r = rectOf(B, 'cc')
  Object.assign(ringB.style, { left: `${r.x - 7}px`, top: `${r.y - 7}px`, width: `${r.w + 14}px`, height: `${r.h + 14}px` })
}
const toastB = add(B.win, '<div class="toast">✓ Invoice posted · coded to 0400 capital expenditure</div>')
{
  const r = rectOf(B, 'post')
  Object.assign(toastB.style, { position: 'absolute', left: `${r.x + r.w - 470}px`, top: `${r.y + 60}px`, zIndex: 18 })
}

// ------------------------------------------------------------------ DOM: Protégé panel, bubbles, cards
const panel = add(FX, `<div class="panel glass">
  <div class="hd"><span class="dot"></span>Recording<span class="tm">0:00</span></div>
  <h3>Posting supplier invoices</h3>
  <div class="step"><div class="th" style="background-image:url('../web/assets/erp-invoice.webp');background-position:0 40%"></div><div><div class="n">STEP 1 · 0:08</div><div class="tt">Open <b>INV-4471</b> · Nordwerk Equipment</div></div></div>
  <div class="step"><div class="th" style="background-image:url('../web/assets/erp-invoice.webp');background-position:70% 20%;background-size:250%"></div><div><div class="n">STEP 2 · 0:21</div><div class="tt">Check <b>€6,400.00</b> against the PDF</div></div></div>
  <div class="step"><div class="th" style="background-image:url('../web/assets/erp-invoice.webp');background-position:25% 75%;background-size:260%"></div><div><div class="n">STEP 3 · 0:42</div><div class="tt">Enter <b>0400</b> in Cost center</div><div class="mk">IBAN DE•• •••• •••• 3000 · masked</div><div class="why">“Equipment over €5,000 is always capex.”</div></div></div>
</div>`)
const steps = [...panel.querySelectorAll('.step')]
const panelTime = panel.querySelector('.tm')
const stepWhy = panel.querySelector('.why')
const maskChip = add(FX, '<div class="chip mono" style="border-radius:999px;padding:12px 18px;font-size:16px;opacity:0;background:rgba(34,16,40,0.92);border-color:rgba(245,159,223,0.55);box-shadow:0 0 30px rgba(245,159,223,0.45)"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f59fdf" stroke-width="2"><rect x="4" y="10" width="16" height="11" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>IBAN&nbsp;&nbsp;DE•• •••• •••• •••• 3000</div>')

function bubble(cls, who, text) {
  const left = cls === 'sabine' ? '<div class="av">S</div>' : '<div class="wave">' + '<i></i>'.repeat(7) + '</div>'
  const n = add(FX, `<div class="bubble glass ${cls}">${left}<div><div class="who">${who}</div><div class="txt">${text}</div></div></div>`)
  return { n, words: splitWords(n.querySelector('.txt')), bars: [...n.querySelectorAll('.wave i')] }
}
const bG1 = bubble('ghost', 'Protégé asks', '“You moved that one to capex. What made you do that?”')
const bS1 = bubble('sabine', 'Sabine', 'Equipment over €5,000 is always capex.')
const bG2 = bubble('ghost', 'Protégé', '“Sabine would stop here. Why do you think?”')
function setBubble(b, x, y, a, t, l, scale = 1) {
  op(b.n, a)
  place(b.n, x, y, `scale(${scale})`)
  if (a <= 0) return
  wordsReveal(b.words, t, l.t, l.max)
  const amp = voiceAmp(t, l)
  b.bars.forEach((bar, i) => { bar.style.height = `${6 + amp * 30 * (0.4 + 0.6 * Math.abs(Math.sin(t * (9 + i * 2.3) + i)))}px` })
}

const replay = add(FX, `<div class="replay glass">
  <div class="img mini"><div class="mf"><label>Description</label><div>Production equipment: milling unit</div></div>
    <div class="mrow"><div class="mf focus"><label>Cost center</label><div>0400</div></div><div class="mf"><label>Asset number</label><div>AS-2026-087</div></div></div>
    <span class="chip mono play" style="background:rgba(10,8,16,0.8)">▶ Sabine · step 3 · 0:42</span></div>
  <div class="q">“Equipment over €5,000 is always capex.”</div>
  <div class="meta">Guardrail · No asset number, no capex booking</div>
</div>`)
const mastery = add(FX, `<div class="mastery glass">
  <div class="k">Lesson report · Jonas</div>
  <div class="v">92<span>% mastery</span></div>
  <div class="bar2"><i></i></div>
  <ul><li><b>✓</b>Caught before saving: cost center</li><li><b>✓</b>Asset number added</li><li><b>✓</b>4 of 4 steps completed</li></ul>
</div>`)
const lessonChip = add(FX, '<div class="chip glass" style="padding:12px 18px;border-radius:999px;opacity:0"><span class="dot" style="background:#8fe3c0;box-shadow:0 0 12px #8fe3c0"></span>Lesson · New hire · Posting supplier invoices</div>')

// Speed lines behind the flying ghost.
const speed = add(FX, '<div style="width:220px;height:90px;opacity:0;transform-origin:100% 50%"><i style="position:absolute;right:0;top:12px;width:150px;height:10px;border-radius:6px;background:#7cc7f4;box-shadow:0 0 14px #7cc7f4"></i><i style="position:absolute;right:30px;top:40px;width:200px;height:10px;border-radius:6px;background:#b38de8;box-shadow:0 0 14px #b38de8"></i><i style="position:absolute;right:0;top:68px;width:140px;height:10px;border-radius:6px;background:#f59fdf;box-shadow:0 0 14px #f59fdf"></i></div>')

// Map labels (scene 4).
const MAPL = [
  { node: 0, dx: -40, dy: 70, html: '<div class="k">Step 1</div><div class="t">Open the invoice and check the amount against the PDF</div>' },
  { node: 1, dx: -420, dy: -215, html: '<div class="k">Step 2 <em class="dec">Decision</em></div><div class="t">Re-code opex 6100 → capex 0400</div><div class="q">“Equipment over €5,000 is always capex.”<b>SABINE · 0:42</b></div>' },
  { node: 2, dx: 70, dy: 40, html: '<div class="k">Step 3 <em class="grd">Guardrail</em></div><div class="t">No asset number, no capex booking</div>' },
  { node: 3, dx: -120, dy: -200, html: '<div class="k">Step 4</div><div class="t">Post and confirm the summary</div>' },
].map((m) => ({ ...m, n: add(FX, `<div class="mlabel glass">${m.html}</div>`) }))

// Protégé dashboard: Work Map page.
const dash = add(UI, `<div class="dash">
  <span class="eyebrow">WORK MAP · ACCOUNTS PAYABLE</span>
  <h1>Posting a supplier invoice</h1>
  <div class="row"><span class="chip">Expert · Sabine</span><span class="chip">4 steps · 2 decisions · 1 guardrail</span><span class="chip">From 1 recording + debrief</span></div>
  <div class="cols">
    <div class="tl">
      <div class="ti"><div class="tt">1 · Open the invoice and check the amount against the PDF</div></div>
      <div class="ti"><div class="tt">2 · Re-code from opex 6100 to capex 0400</div><div class="q">“Equipment over €5,000 is always capex.”</div><div class="chips"><span class="chip">Decision</span><span class="chip mono">Sabine · 0:42</span></div></div>
      <div class="ti"><div class="tt">3 · Add the asset number</div><div class="chips"><span class="chip" style="color:#ffc6ee;border-color:rgba(245,159,223,.45)">Guardrail · No asset number, no capex booking</span></div></div>
      <div class="ti"><div class="tt">4 · Post and confirm the summary</div></div>
    </div>
    <div class="side"><div class="img"></div><div class="tt">Step guide · 4 steps with screenshots</div><div class="mt">IBAN masked · 1 region blurred</div><div class="btns"><span class="chip">Export PDF</span><span class="chip">Edit guide</span></div></div>
  </div>
  <div class="stamp">✓ Confirmed by Sabine</div>
</div>`)
const dashItems = [...dash.querySelectorAll('.ti')], dashSide = dash.querySelector('.side'), stamp = dash.querySelector('.stamp')

// Trust chips (scene 6) and App Profile cards.
const LOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="10" width="16" height="11" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>'
const TCH = [
  `${LOCK}Password field · never read`, '<span class="m">IBAN DE•• •••• •••• 3000</span>', '<span class="m">Card •••• •••• •••• 4242</span>',
  'Off the record · <span class="m">Ctrl+Shift+O</span>', 'Memory stored locally', 'Skips password managers & banking',
].map((h) => add(FX, `<div class="tchip glass">${h}</div>`))
const PROF = [
  ['MiniERP', '#24574a', 'M', '412 masked events today', 0.82],
  ['Excel', '#1f7a4a', 'X', 'Month-end close · 38 fields', 0.64],
  ['Outlook', '#2a62c9', 'O', 'Supplier mail · text only', 0.48],
  ['Edge', '#3a4f9e', 'E', 'Bank portal · skipped', 0.2],
].map(([nm, bg, ic, mt, w]) => add(FX, `<div class="pcard glass"><div class="ic" style="background:${bg}">${ic}</div><div class="nm">${nm}</div><div class="mt">${mt}</div><div class="ln"><i style="width:${w * 100}%"></i></div></div>`))

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

// ------------------------------------------------------------------ the timeline
function cameraAt(t) {
  // Scenes 1-2: one continuous move; UI scenes: fixed; scene 4: orbit; scenes 6-7: push-ins.
  if (t < 14) {
    const p = track([[0, [0.9, 0.35, 15.5]], [8, [-0.2, 0.1, 12.4]], [11.2, [0, 0.1, 10.6], E.out], [14, [0, 0.05, 9.7]]], t, E.sine)
    return { p, look: [0, track([[0, 0.3], [8, 0.1], [11, -0.6]], t), 0], fov: 35 }
  }
  if (t >= 29.2 && t < 35.6) {
    const a = track([[29.2, -0.42], [35.6, 0.3]], t, E.sine)
    const rad = track([[29.2, 13.5], [35.6, 11.2]], t, E.sine)
    return { p: [Math.sin(a) * rad, track([[29.2, 2.0], [35.6, 0.7]], t), Math.cos(a) * rad], look: [0, 0.2, 0], fov: 35 }
  }
  if (t >= 54.2 && t < 60) return { p: [0, 0.15, track([[54.2, 11], [60, 9.4]], t, E.sine)], look: [0, 0.15, 0], fov: 35 }
  if (t >= 60) return { p: [0, 0.2, track([[60, 11.6], [66, 10.2]], t, E.sine)], look: [0, 0.2, 0], fov: 35 }
  return { p: [0, 0, 10], look: [0, 0, 0], fov: 35 }
}

// Ghost state per time: position (world), scale, rotation, visibility.
function ghostAt(t) {
  const bob = Math.sin(t * 2.1) * 0.06
  // scene 2: materialise at origin, then shoot off to the top right.
  if (t < 14) {
    const out = E.in(prog(t, 13.25, 13.95))
    return { on: t > 10.9, p: [out * 7, bob + out * 4.5, out * 2], s: 1 + out * 0.4, ry: Math.sin(t * 0.6) * 0.18 - out * 0.5, rz: -out * 0.5, mat: E.out(prog(t, 10.95, 11.5)) }
  }
  if (t < 29.2) {
    if (t < 21.7) return { on: false }
    const k = E.back(prog(t, 21.7, 22.45))
    const out = E.in(prog(t, 28.5, 29.15))
    const sx = lerp(2150, 1265, k) + out * 900, sy = lerp(80, 300, k) - out * 260
    const w = screenToWorld(sx, sy)
    const fly = (1 - prog(t, 21.7, 22.5)) + out
    return { on: true, p: [w.x, w.y + bob * 0.5, 0], s: 0.42, ry: -0.35 + Math.sin(t * 0.8) * 0.12, rz: 0.35 * fly, speed: fly, dir: Math.PI * 0.82 }
  }
  if (t < 35.6) {
    const k = E.out(prog(t, 30.0, 31.0))
    const out = E.in(prog(t, 34.8, 35.5))
    return { on: t > 30, p: [-1.5 + (1 - k) * 4 + out * 5, 2.45 + bob - (1 - k) * 2 + out * 4, -0.8], s: 0.34, ry: 0.4 + Math.sin(t * 0.7) * 0.2, rz: 0, mat: k }
  }
  if (t < 40.4) return { on: false }
  if (t < 54.3) {
    // idle at the top right, then fly to the cost center field, celebrate, then rise.
    const idle = [1715, 255]
    const f = screenRect(B.fields.cc)
    const fieldPos = [f.x - 95, f.cy - 20]
    const kin = E.back(prog(t, 40.5, 41.2))
    const kfly = E.inOut(prog(t, 44.6, 45.3))
    const kback = E.inOut(prog(t, 51.8, 52.8))
    let sx = lerp(2150, idle[0], kin), sy = lerp(120, idle[1], kin)
    // arc to the field
    sx = lerp(sx, fieldPos[0], kfly); sy = lerp(sy, fieldPos[1], kfly) - Math.sin(kfly * Math.PI) * 140
    sx = lerp(sx, 1640, kback); sy = lerp(sy, 230, kback)
    const out = E.in(prog(t, 53.7, 54.3))
    sy -= out * 500; sx += out * 200
    const w = screenToWorld(sx, sy)
    const flying = Math.sin(kfly * Math.PI) + (1 - prog(t, 40.5, 41.0)) * (t > 40.5 ? 1 : 0) + out
    const spin = E.inOut(prog(t, 51.0, 51.8)) * Math.PI * 2
    const hop = Math.sin(prog(t, 51.0, 51.8) * Math.PI) * 0.35
    return { on: true, p: [w.x, w.y + bob * 0.5 + hop, 0], s: 0.4 - kfly * 0.04 * (1 - kback), ry: -0.5 + kfly * 0.95 * (1 - kback) + spin, rz: -0.45 * Math.sin(kfly * Math.PI) + 0.3 * (1 - prog(t, 40.5, 41.1)), speed: flying, dir: kfly > 0 && kfly < 1 ? -Math.PI * 0.12 : Math.PI * 0.85 }
  }
  if (t < 60) {
    const k = E.out(prog(t, 54.3, 55.1))
    const out = E.in(prog(t, 59.4, 60))
    return { on: true, p: [0, 0.1 + bob + (1 - k) * 4 + out * 0.5, 0], s: 0.82 - out * 0.3, ry: Math.sin(t * 0.5) * 0.25, rz: 0, mat: 1 }
  }
  const k = E.out(prog(t, 60.05, 61.0))
  return { on: true, p: [0, 1.3 + bob, 0], s: 0.48 + 0.03 * k, ry: Math.sin(t * 0.45) * 0.2, rz: 0, mat: k }
}

function seek(t) {
  t = clamp(t, 0, DURATION)
  const frame = Math.round(t * 30)
  const L = Object.fromEntries(LINES.map((l) => [l.id, l]))

  // ---- camera with a little handheld drift and impact shake
  const cam = cameraAt(t)
  const shake = Math.exp(-Math.max(0, t - 11.25) * 5) * (t > 11.25 ? 1 : 0) + Math.exp(-Math.max(0, t - 60.6) * 5) * (t > 60.6 ? 0.7 : 0) + Math.exp(-Math.max(0, t - 44.45) * 6) * (t > 44.45 ? 0.5 : 0)
  camera.position.set(cam.p[0] + drift(t, 1) * 0.05 + Math.sin(t * 61) * shake * 0.08, cam.p[1] + drift(t, 2) * 0.04 + Math.sin(t * 53) * shake * 0.06, cam.p[2])
  camera.fov = cam.fov
  camera.updateProjectionMatrix()
  camera.lookAt(cam.look[0], cam.look[1], cam.look[2])
  camera.updateMatrixWorld()

  // ---- background aura
  const auraA = 0.35 + 0.65 * prog(t, 8, 12)
  $('bg').querySelectorAll('.aura').forEach((a, i) => {
    a.style.opacity = auraA * (0.8 + 0.2 * Math.sin(t * 0.4 + i * 2))
    a.style.transform = `translate(${drift(t * 0.3, i * 3) * 60}px, ${drift(t * 0.25, i * 5 + 1) * 40}px)`
  })

  // ---- scene 1: knowledge orbs and their labels
  const orbOn = t < 9.5
  orbGroup.visible = orbOn
  if (orbOn) {
    ORBS.forEach((o, i) => {
      const appear = E.back(prog(t, 0.2 + i * 0.22, 1.0 + i * 0.22))
      const dissolve = E.in(prog(t, 5.4 + i * 0.12, 6.9 + i * 0.12))
      const s = o.r * clamp(appear) * (1 - dissolve) * (1 + Math.sin(t * 2 + i) * 0.04)
      o.mesh.scale.setScalar(Math.max(0.0001, s))
      o.mesh.position.set(o.p[0], o.p[1] + Math.sin(t * 0.8 + i) * 0.08, o.p[2])
      if (o.label) {
        const sp = toScreen(o.mesh.position)
        const a = E.out(prog(t, 1.2 + i * 0.3, 1.9 + i * 0.3)) * (1 - E.in(prog(t, 5.2 + i * 0.1, 6.1 + i * 0.1)))
        op(o.label, a * 0.95)
        const dy = -58
        o.label.style.transform = `translate(${sp.x}px, ${sp.y + dy}px) translate(-50%, -50%)`
        o.label.style.filter = a < 0.98 ? `blur(${((1 - a) * 8).toFixed(1)}px)` : 'none'
      }
    })
    linkMat.opacity = 0.32 * E.out(prog(t, 1.2, 3)) * (1 - E.in(prog(t, 5.0, 6.4)))
  } else ORBS.forEach((o) => o.label && op(o.label, 0))
  updateSwarm(t)

  // ---- ghost
  const g = ghostAt(t)
  ghost.visible = !!g.on
  const speak = Math.max(voiceAmp(t, L.g1), voiceAmp(t, L.g2))
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
    floor.visible = t < 14 || t >= 54.2
    floor.material.opacity = 0.7 * mat
    const blink = [3.1, 7.4, 12.6, 19.2, 24.0, 33.2, 42.3, 47.9, 56.6, 62.8].some((b) => t > b && t < b + 0.14) ? 0.12 : 1
    eyes.forEach((e) => { e.scale.y = 0.175 * blink })
  }
  // speed lines
  if (g.on && g.speed > 0.15) {
    const sp = toScreen(ghost.position)
    op(speed, clamp(g.speed) * 0.9)
    speed.style.transform = `translate(${sp.x - 220 - 90}px, ${sp.y - 45}px) rotate(${(g.dir || 0) + Math.PI}rad) translateX(${0}px)`
    speed.style.transformOrigin = '310px 45px'
  } else op(speed, 0)

  // bubbles: scene 2 and the end card
  const bubA = Math.max(env(t, 11.3, 13.4, 0.8, 0.4), env(t, 60.3, 67, 1.0, 0.1))
  bubbles.visible = bubA > 0.01
  if (bubbles.visible) {
    bubbles.position.copy(ghost.position)
    bubbleMat.uniforms.uT.value = t
    bubbles.children.forEach((b, i) => {
      const [x, y, z, r] = b.userData.base
      const pop = E.back(prog(t, (t < 30 ? 11.35 : 60.4) + i * 0.09, (t < 30 ? 11.95 : 61.0) + i * 0.09))
      b.position.set(x * (t > 30 ? 1.35 : 1), y * (t > 30 ? 0.7 : 1) + Math.sin(t * 0.9 + i * 1.7) * 0.15, z)
      b.scale.setScalar(Math.max(0.0001, r * clamp(pop) * (t > 30 ? 0.85 : 1)))
    })
  }

  // dust: 3D scenes only
  const dustA = Math.max(env(t, 0, 14, 1.5, 0.6), env(t, 29.2, 35.6, 0.5, 0.5), env(t, 54.3, 66, 0.6, 0.6))
  updateDust(t, dustA)

  // ---- scene 4: Work Map constellation
  const mapOn = t > 29.2 && t < 35.8
  mapGroup.visible = mapOn
  if (mapOn) {
    const fadeOut = E.in(prog(t, 35.0, 35.8))
    NODES.forEach((n, i) => {
      const a = E.back(prog(t, 30.0 + i * 0.75, 30.6 + i * 0.75))
      n.mesh.scale.setScalar(Math.max(0.0001, n.r * clamp(a) * (1 - fadeOut)))
      n.mesh.position.set(n.p[0], n.p[1] + Math.sin(t + i) * 0.06, n.p[2])
      if (n.ringMesh) n.ringMesh.rotation.z = t * 0.8
    })
    mapTubes.forEach((m, i) => {
      const k = E.inOut(prog(t, 30.35 + i * 0.75, 31.0 + i * 0.75)) * (1 - fadeOut)
      m.geometry.setDrawRange(0, Math.floor(m.geometry.index.count * k / 6) * 6)
    })
    mapStars.children.forEach((s, i) => { s.material.opacity = 0.5 * E.out(prog(t, 29.4 + i * 0.05, 30.4)) * (1 - fadeOut) })
  }
  MAPL.forEach((m, i) => {
    const a = mapOn ? E.out(prog(t, 30.4 + i * 0.75, 31.0 + i * 0.75)) * (1 - E.in(prog(t, 34.8, 35.4))) : 0
    op(m.n, a)
    if (a > 0) {
      const sp = toScreen(NODES[m.node].mesh.position)
      m.n.style.transform = `translate(${sp.x + m.dx}px, ${sp.y + m.dy + (1 - a) * 20}px)`
      m.n.style.filter = a < 0.98 ? `blur(${((1 - a) * 6).toFixed(1)}px)` : 'none'
    }
  })

  // ---- scene 6: shield
  const shA = env(t, 54.6, 59.8, 0.8, 0.5)
  shield.visible = shA > 0.001
  if (shield.visible) {
    shield.position.copy(ghost.position).setY(0.15)
    shield.scale.setScalar(Math.max(0.001, 0.86 * E.back(prog(t, 54.6, 55.5)) * (1 + Math.sin(t * 2) * 0.01)))
    shield.rotation.y = t * 0.15
    shieldMat.uniforms.uT.value = t
    shieldMat.uniforms.uA.value = shA * 0.9
  }

  renderer.render(scene, camera)

  // ================================================================ DOM layers
  // ---- titles: scene 1
  charReveal(chars.loss1o, t, 0.9, { stagger: 0.02, dur: 0.6, rise: 10, blur: 6, out: 3.75, outDur: 0.4, outStagger: 0.005 })
  charReveal(chars.loss1, t, 1.05, { out: 3.7, outDur: 0.5 })
  op(T.loss1o, t < 4.5 ? 1 : 0); op(T.loss1, t < 4.5 ? 1 : 0)
  charReveal(chars.loss2, t, 4.3, { out: 6.3, scatter: true, outDur: 1.2, outStagger: 0.02 })
  op(T.loss2, t > 4.2 && t < 8.2 ? 1 : 0)

  // ---- scene 2: wordmark
  {
    const a = E.out(prog(t, 11.35, 12.3)) * (1 - E.in(prog(t, 13.1, 13.6)))
    op(T.brand, a)
    const wipe = E.out(prog(t, 11.3, 12.4))
    T.brand.style.clipPath = `inset(0 ${(1 - wipe) * 50}% 0 ${(1 - wipe) * 50}%)`
    T.brand.style.filter = `blur(${((1 - E.out(prog(t, 11.3, 12.2))) * 18 + E.in(prog(t, 13.1, 13.6)) * 14).toFixed(1)}px)`
    T.brand.style.transform = `scale(${1.08 - 0.08 * E.out(prog(t, 11.3, 13.4))}) translateY(${-E.in(prog(t, 13.1, 13.6)) * 30}px)`
    op(T.brandSub, E.out(prog(t, 12.0, 12.6)) * (1 - E.in(prog(t, 13.1, 13.5))) * 0.9)
    T.brandSub.style.letterSpacing = `${0.32 + 0.1 * prog(t, 12, 13.5)}em`
  }

  // ---- chapter cards
  const chap = (el, co, t0, t1) => {
    const a = E.out(prog(t, t0, t0 + 0.45)) * (1 - E.in(prog(t, t0 + 1.0, t0 + 1.45)))
    op(el, a)
    el.style.transform = `scale(${0.94 + 0.06 * E.out(prog(t, t0, t0 + 1.4)) + E.in(prog(t, t0 + 1.0, t0 + 1.45)) * 0.12})`
    el.style.filter = a < 0.99 ? `blur(${((1 - a) * 16).toFixed(1)}px)` : 'none'
    const c = E.out(prog(t, t0 + 1.25, t0 + 1.8)) * (1 - E.in(prog(t, t1 - 0.5, t1)))
    op(co, c)
    co.style.transform = `translateX(${(1 - c) * -24}px)`
  }
  chap(T.ch1, T.co1, 14.0, 29.0)
  chap(T.ch2, T.co2, 29.15, 39.9)
  chap(T.ch3, T.co3, 40.0, 54.2)

  // ---- scene 3: capture in MiniERP
  {
    const vis = t > 14.2 && t < 29.4
    const kin = E.out(prog(t, 14.5, 16.0))
    const kout = E.in(prog(t, 28.6, 29.3))
    const s = 0.8 * (0.7 + 0.3 * kin) + kout * 0.15
    setWin(A, {
      cx: 800 + (1 - kin) * 260 - kout * 200, cy: 600 + (1 - kin) * 120, s,
      rx: 5 + (1 - kin) * 16 + drift(t, 4) * 0.4, ry: -13 + (1 - kin) * 30 + prog(t, 16, 28) * 5 + drift(t, 7) * 0.5, rz: (1 - kin) * -4,
      z: -(1 - kin) * 500, o: vis ? E.out(prog(t, 14.5, 15.3)) * (1 - kout) : 0,
      filter: kout > 0 ? `blur(${kout * 16}px)` : 'none',
    })
    if (vis) {
      const inv = relRect(A.list, A.win), cc = rectOf(A, 'cc')
      const path = [[14.5, [1120, 760]], [16.15, [inv.x + 160, inv.y + 40]], [17.0, [inv.x + 200, inv.y + 60]], [18.6, [700, 380]], [19.05, [cc.x + 120, cc.cy]], [20.2, [cc.x + 140, cc.cy + 8]], [21.0, [cc.x + 210, cc.cy + 70]], [29, [cc.x + 230, cc.cy + 90]]]
      setCursor(A, path, t, [16.2, 19.1])
      // the selected invoice glows once clicked
      A.list.style.boxShadow = t > 16.2 ? 'inset 4px 0 0 #2f6f58, inset 0 0 0 2px rgba(179,141,232,0.5)' : ''
      // accessibility scan: beam sweeps the window
      const ks = prog(t, 16.8, 18.6)
      const beamY = lerp(-160, 880, E.sine(ks))
      op(A.scan, ks > 0 && ks < 1 ? Math.sin(ks * Math.PI) * 0.95 + 0.05 : 0)
      A.scan.style.transform = `translateY(${beamY}px)`
      TAGS.forEach(({ n, r, f }) => {
        const hit = beamY + 160 > r.y
        const on = ks > 0 && hit ? 1 : 0
        const keep = f === 'cc' || f === 'bank' ? 1 - prog(t, 21.6, 22.2) : 1 - prog(t, 19.0, 19.5)
        op(n, on * keep)
      })
      // cost center: 6100 → 0400
      A.fields.cc.classList.toggle('focus', t > 19.1 && t < 20.4)
      const typed = '0400'.slice(0, Math.floor(clamp((t - 19.5) / 0.55) * 4 + 0.0001))
      if (t < 19.3) setVal(A, 'cc', '6100')
      else if (t < 19.5) setVal(A, 'cc', '<span style="background:#b5d7ff">6100</span>')
      else setVal(A, 'cc', typed + (t < 20.4 && Math.floor(t * 3) % 2 === 0 ? '<span class="caret"></span>' : ''))
      // masked IBAN chip flies from the bank field toward the panel
      const bank = screenRect(A.fields.bank)
      const km = E.inOut(prog(t, 20.6, 21.5))
      op(maskChip, env(t, 20.5, 22.4, 0.3, 0.5))
      place(maskChip, lerp(bank.x + 40, 1440, km), lerp(bank.y - 6, 700, km), `scale(${1 - km * 0.15})`)
    } else { op(maskChip, 0) }
  }
  // panel
  {
    const kin = E.out(prog(t, 15.4, 16.3)), kout = E.in(prog(t, 28.6, 29.2))
    op(panel, kin * (1 - kout))
    place(panel, 1430 + (1 - kin) * 120 + kout * 80, 170 + drift(t, 9) * 3, `perspective(1400px) rotateY(${-10 + (1 - kin) * -20}deg)`)
    const rec = Math.max(0, t - 15.4) + 0
    panelTime.textContent = `0:${String(Math.floor(rec * 2.8 + 4)).padStart(2, '0')}`
    const stepT = [16.5, 18.3, 21.3]
    steps.forEach((st, i) => {
      const a = E.back(prog(t, stepT[i], stepT[i] + 0.5))
      op(st, clamp(a))
      st.style.transform = `translateY(${(1 - clamp(a)) * 24}px) scale(${0.96 + 0.04 * clamp(a)})`
    })
    const kw = E.out(prog(t, 27.4, 28.1))
    stepWhy.style.maxHeight = `${kw * 60}px`
    stepWhy.style.opacity = kw
    panel.querySelector('.mk').style.opacity = E.out(prog(t, 21.4, 21.9))
  }
  // ghost question + Sabine's answer
  {
    const gp = ghost.visible ? toScreen(ghost.position) : { x: 1265, y: 300 }
    const a1 = t < 30 ? env(t, 22.25, 28.5, 0.35, 0.4) : 0
    setBubble(bG1, gp.x - 640, gp.y - 70, a1, t, L.g1, 0.96 + 0.04 * E.out(prog(t, 22.25, 22.7)))
    const a2 = env(t, 25.35, 28.6, 0.35, 0.4)
    setBubble(bS1, 330, 820 + (1 - E.out(prog(t, 25.35, 25.9))) * 30, a2, t, L.s1)
  }

  // ---- scene 4: the Work Map page
  {
    const kin = E.out(prog(t, 35.3, 36.4)), kout = E.in(prog(t, 39.3, 40.0))
    op(dash, kin * (1 - kout))
    dash.style.left = '210px'; dash.style.top = '150px'
    dash.style.transform = `translateZ(${-(1 - kin) * 600 + kout * 200}px) rotateX(${(1 - kin) * 22 + 4 + drift(t, 3) * 0.3}deg) rotateY(${-6 + prog(t, 35.3, 40) * 6}deg)`
    dash.style.filter = kout > 0 ? `blur(${kout * 14}px)` : 'none'
    dashItems.forEach((n, i) => { const a = E.out(prog(t, 35.9 + i * 0.22, 36.4 + i * 0.22)); op(n, a); n.style.transform = `translateX(${(1 - a) * -30}px)` })
    { const a = E.out(prog(t, 36.2, 36.8)); op(dashSide, a); dashSide.style.transform = `translateY(${(1 - a) * 30}px)` }
    const ks = prog(t, 37.15, 37.5)
    op(stamp, E.out(ks))
    stamp.style.transform = `scale(${lerp(1.8, 1, E.out(ks))}) rotate(${lerp(-12, -4, E.out(ks))}deg)`
  }

  // ---- scene 5: teach
  {
    const vis = t > 40.2 && t < 54.4
    const kin = E.out(prog(t, 40.4, 41.8)), kout = E.in(prog(t, 53.7, 54.3))
    const freeze = E.out(prog(t, 44.45, 44.75)) * (1 - E.inOut(prog(t, 48.2, 48.8)))
    setWin(B, {
      cx: 860 - (1 - kin) * 300 - freeze * 40, cy: 600 + (1 - kin) * 80 + freeze * 20, s: 0.8 * (0.75 + 0.25 * kin) * (1 + freeze * 0.05) + kout * 0.1,
      rx: 5 + (1 - kin) * 14 + drift(t, 5) * 0.4, ry: 9 - (1 - kin) * 28 - prog(t, 41, 53) * 4 + drift(t, 8) * 0.5, rz: (1 - kin) * 3,
      z: -(1 - kin) * 500, o: vis ? E.out(prog(t, 40.4, 41.1)) * (1 - kout) : 0,
      filter: `saturate(${1 - freeze * 0.55}) ${kout > 0 ? `blur(${kout * 16}px)` : ''}`,
    })
    op(B.dim, 1)
    B.dim.style.background = `rgba(10, 6, 22, ${freeze * 0.32})`
    if (vis) {
      const cc = rectOf(B, 'cc'), post = rectOf(B, 'post'), asset = rectOf(B, 'asset')
      const path = [[40.4, [900, 820]], [41.95, [cc.x + 200, cc.cy]], [42.5, [cc.x + 160, cc.y + 76]], [42.85, [cc.x + 150, cc.y + 76]], [43.3, [cc.x + 260, cc.cy + 40]], [44.4, [post.cx - 10, post.cy - 26], E.out],
        [48.6, [post.cx - 10, post.cy - 26]], [48.95, [cc.x + 200, cc.cy]], [49.15, [cc.x + 160, cc.y + 116]], [49.35, [cc.x + 150, cc.y + 116]], [49.65, [asset.x + 150, asset.cy]], [50.5, [asset.x + 200, asset.cy + 10]], [50.85, [post.cx, post.cy]], [54, [post.cx + 20, post.cy + 30]]]
      setCursor(B, path, t, [42.0, 42.9, 48.95, 49.35, 49.68, 50.85])
      // menu open/close
      const menuOn = (t > 42.05 && t < 42.95) || (t > 49.0 && t < 49.4)
      op(B.menu, menuOn ? 1 : 0)
      const opts = B.menu.querySelectorAll('div')
      opts[0].classList.toggle('hi', t > 42.4 && t < 42.95)
      opts[1].classList.toggle('hi', t > 49.2)
      if (t < 42.9) setVal(B, 'cc', '<span class="ph">Select cost center</span>')
      else if (t < 49.35) setVal(B, 'cc', '6100')
      else setVal(B, 'cc', '0400')
      B.fields.cc.classList.toggle('focus', menuOn)
      const assetTxt = 'AS-2026-114'.slice(0, Math.floor(clamp((t - 49.75) / 0.6) * 11 + 0.0001))
      if (t < 49.75) setVal(B, 'asset', '<span class="ph">Enter asset reference</span>')
      else setVal(B, 'asset', assetTxt + (t < 50.5 && Math.floor(t * 3) % 2 === 0 ? '<span class="caret"></span>' : ''))
      B.fields.asset.classList.toggle('focus', t > 49.68 && t < 50.6)
      // the ring around the field: pink while warning, green once fixed
      const ra = env(t, 45.05, 50.6, 0.3, 0.6)
      op(ringB, ra)
      ringB.classList.toggle('ok', t > 49.4)
      ringB.style.transform = `scale(${1 + 0.03 * Math.sin(t * 7) * (t < 49.4 ? 1 : 0.3)})`
      // post button press + toast
      B.fields.post.style.transform = t > 50.85 && t < 51.05 ? 'scale(0.95)' : 'none'
      const ta = env(t, 51.0, 53.8, 0.3, 0.4)
      op(toastB, ta)
      toastB.style.transform = `translateY(${(1 - E.out(prog(t, 51.0, 51.4))) * 14}px)`
      B.win.querySelector('.status').textContent = t > 51 ? 'Posted' : 'Pending'
    }
    op(lessonChip, env(t, 41.0, 54.0, 0.5, 0.4))
    place(lessonChip, 760, 52)
    // ghost speech + Sabine's replay
    const gp = ghost.visible ? toScreen(ghost.position) : { x: 0, y: 0 }
    setBubble(bG2, gp.x - 60, gp.y - 250, t > 39 ? env(t, 45.35, 48.6, 0.35, 0.4) : 0, t, L.g2, 0.92)
    const rk = E.out(prog(t, 46.6, 47.2))
    op(replay, rk * (1 - E.in(prog(t, 51.2, 51.7))))
    place(replay, 1440 + (1 - rk) * 60, 360, `perspective(1400px) rotateY(${-12 + (1 - rk) * -15}deg)`)
    const mk = E.out(prog(t, 51.6, 52.2))
    op(mastery, mk * (1 - E.in(prog(t, 53.7, 54.2))))
    place(mastery, 1470 + (1 - mk) * 60, 380, `perspective(1400px) rotateY(-12deg)`)
    mastery.querySelector('.bar2 i').style.width = `${E.out(prog(t, 52.0, 53.2)) * 92}%`
    mastery.querySelector('.v').firstChild.textContent = String(Math.round(E.out(prog(t, 52.0, 53.2)) * 92))
  }

  // ---- scene 6: trust + always on
  {
    charReveal(chars.trust1, t, 55.1, { out: 57.2, outDur: 0.5 })
    op(T.trust1, t > 55 && t < 58 ? 1 : 0)
    charReveal(chars.trust2, t, 57.55, { out: 59.4, outDur: 0.5, stagger: 0.02 })
    op(T.trust2, t > 57.4 && t < 60.2 ? 1 : 0)
    const center = new THREE.Vector3(0, 0.15, 0)
    TCH.forEach((n, i) => {
      const a = env(t, 55.2 + i * 0.22, 57.6, 0.4, 0.5)
      op(n, a)
      if (a <= 0) return
      const ang = (i / TCH.length) * Math.PI * 2 + t * 0.32
      const v = new THREE.Vector3(Math.cos(ang) * 4.5, Math.sin(ang) * 0.5 + (i % 2 ? 1.25 : -1.35), Math.sin(ang) * 1.6).add(center)
      const sp = toScreen(v)
      const depth = 0.65 + 0.35 * clamp((Math.sin(ang) + 1) / 2)
      n.style.transform = `translate(${sp.x}px, ${sp.y + (1 - a) * 20}px) translate(-50%, -50%) scale(${0.85 + depth * 0.2})`
      n.style.opacity = a * depth
      n.style.zIndex = Math.sin(ang) > 0 ? 2 : 0
    })
    PROF.forEach((n, i) => {
      const a = env(t, 57.7 + i * 0.16, 59.7, 0.45, 0.4)
      op(n, a)
      const x = 960 - 2 * 270 + i * 270 + 10
      n.style.transform = `translate(${x}px, ${785 + (1 - a) * 40 + Math.sin(t * 1.5 + i) * 4}px) rotateZ(${(i - 1.5) * 1.2}deg)`
    })
  }

  // ---- scene 7: end card
  {
    const a = E.out(prog(t, 60.7, 61.8))
    op(T.endMark, a)
    const wipe = E.out(prog(t, 60.6, 61.8))
    T.endMark.style.clipPath = `inset(0 ${(1 - wipe) * 50}% 0 ${(1 - wipe) * 50}%)`
    T.endMark.style.filter = `blur(${((1 - E.out(prog(t, 60.6, 61.6))) * 20).toFixed(1)}px)`
    T.endMark.style.transform = `scale(${1.1 - 0.1 * E.out(prog(t, 60.6, 65))}) translateY(-30px)`
    charReveal(chars.endTag, t, 62.0, { stagger: 0.018, rise: 20, blur: 8 })
    op(T.endTag, t > 61.9 ? 1 : 0)
    T.endTag.style.transform = 'translateY(-55px)'
    const pa = E.out(prog(t, 63.0, 63.7))
    op(T.endPills, pa); T.endPills.style.transform = `translateY(${-62 + (1 - pa) * 16}px)`
    const ca = E.out(prog(t, 63.6, 64.3)) * 0.85
    op(T.credit, ca); T.credit.style.transform = 'translateY(-62px)'
  }

  // ---- post: letterbox, flashes, leaks, grain, fade
  const bars = 1 - E.inOut(prog(t, 13.5, 14.4)) + E.inOut(prog(t, 59.9, 60.8))
  $('barTop').style.transform = `translateY(${-(1 - clamp(bars)) * 140}px)`
  $('barBot').style.transform = `translateY(${(1 - clamp(bars)) * 140}px)`
  const fl = Math.max(Math.exp(-Math.max(0, t - 11.2) * 3.2) * (t > 11.05 ? 1 : 0) * E.out(prog(t, 11.05, 11.2)), 0.8 * Math.exp(-Math.max(0, t - 60.6) * 3) * (t > 60.45 ? 1 : 0) * E.out(prog(t, 60.45, 60.6)), 0.3 * Math.exp(-Math.max(0, t - 44.45) * 6) * (t > 44.45 ? 1 : 0))
  $('flash').style.opacity = fl * 0.85
  const flare = Math.max(env(t, 11.15, 12.6, 0.12, 1.1), env(t, 60.55, 62.2, 0.12, 1.3) * 0.8)
  $('flare').style.opacity = flare
  $('flare').style.transform = `scaleX(${0.6 + flare * 0.6}) translateY(${t < 30 ? 0 : 90}px)`
  const leak = (el, t0, dir) => {
    const k = prog(t, t0 - 0.5, t0 + 0.9)
    el.style.opacity = Math.sin(k * Math.PI) * 0.75
    el.style.transform = `translate(${lerp(-900, 1500, k) * dir + (dir < 0 ? 1400 : 0)}px, ${-200 + Math.sin(k * 3) * 100}px)`
  }
  const leaks = [13.9, 28.95, 39.95, 54.3, 60.1]
  const nearest = leaks.reduce((b, x) => (Math.abs(t - x) < Math.abs(t - b) ? x : b), leaks[0])
  leak($('leak1'), nearest, 1)
  leak($('leak2'), nearest + 0.15, -1)
  grainEl.style.backgroundImage = grainTex[frame % grainTex.length]
  const gr = rng(frame + 1)
  grainEl.style.transform = `translate(${(gr() * 200) | 0}px, ${(gr() * 200) | 0}px)`
  $('fade').style.opacity = Math.max(1 - E.out(prog(t, 0, 0.8)), E.in(prog(t, 65.0, 66)))
}

// ------------------------------------------------------------------ boot
async function boot() {
  await document.fonts.ready
  const urls = ['../web/assets/erp-invoice.webp']
  await Promise.all(urls.map((u) => new Promise((res) => { const i = new Image(); i.onload = i.onerror = res; i.src = u })))
  seek(0)
  window.ready = true
}
window.seek = (t) => { seek(t); return true }
window.DURATION = DURATION
boot()
