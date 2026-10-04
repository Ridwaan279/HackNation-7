// Fullscreen, transparent, click-through overlay: the ghost, its bubble, the pointer highlight,
// and the voice agent. Only elements marked data-hit receive the mouse.
import { animate, motion, useMotionValue } from 'framer-motion'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ConversationProvider } from '@elevenlabs/react'
import { MicrophoneIcon, MicrophoneSlashIcon } from '@phosphor-icons/react'
import type { BusEvents, GhostState, Popup, Rect, SidecarEvent } from '@shared/contracts'
import type { GhostPoint, OverlayGeometry } from '../../common/ipc'
import { AgentHost, type AgentUi } from '../agents/AgentHost'
import { Ghost, type GhostBadge, type GhostPose } from '../mascot/Ghost'
import { invoke, tryInvoke, useChannel } from '../lib/api'
import './overlay.css'

const SIZE = 150
const GHOST_H = (SIZE * 165) / 220
const DOCK_MARGIN = 24
const DEFAULT_TIMEOUT_S = 12
const CAPTION_MS = 7000
const POINT_MS = 6000

const BLOCK_LABEL: Record<string, string> = {
  password_manager: 'password manager',
  banking: 'banking',
  private_window: 'private window',
  system: 'system screen',
  user_blocked: 'blocked app',
  paused: 'paused',
  off_record: 'off the record',
  self: 'Apprentice',
}

type Pt = { x: number; y: number }

/** Click-through everywhere except elements marked data-hit. */
function useClickThrough() {
  useEffect(() => {
    let interactive = false
    const onMove = (e: MouseEvent) => {
      const hit = !!(document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest('[data-hit]')
      if (hit !== interactive) {
        interactive = hit
        void tryInvoke('overlay:setInteractive', hit)
      }
    }
    window.addEventListener('mousemove', onMove)
    return () => window.removeEventListener('mousemove', onMove)
  }, [])
}

export default function Overlay() {
  return (
    <ConversationProvider>
      <OverlayInner />
    </ConversationProvider>
  )
}

function OverlayInner() {
  useClickThrough()
  const [geo, setGeo] = useState<OverlayGeometry | null>(null)
  const [agent, setAgent] = useState<AgentUi>({ agent: null, connected: false, speaking: false, userSpeaking: false, caption: null })
  const [volume, setVolume] = useState(0)
  const [micLevel, setMicLevel] = useState(0)
  const [micName, setMicName] = useState('')
  const [main, setMain] = useState<BusEvents['ghost:state']>({ state: 'idle', badge: null })
  const [blockReason, setBlockReason] = useState<string | null>(null)
  const [popup, setPopup] = useState<Popup | null>(null)
  const [caption, setCaption] = useState<string | null>(null)
  const [flying, setFlying] = useState<GhostPose | null>(null)
  const [target, setTarget] = useState<GhostPoint | null>(null)

  const x = useMotionValue(0)
  const y = useMotionValue(0)
  const home = useRef<Pt | null>(null)
  const dragging = useRef(false)

  useEffect(() => {
    void tryInvoke<OverlayGeometry>('overlay:geometry').then((g) => g && setGeo(g))
  }, [])
  useChannel<OverlayGeometry>('overlay:geometry', setGeo)

  const dock = useCallback((): Pt => {
    if (home.current) return home.current
    if (!geo) return { x: window.innerWidth - SIZE - DOCK_MARGIN, y: window.innerHeight - GHOST_H - DOCK_MARGIN }
    const { bounds: b, workArea: w } = geo
    return { x: w.x - b.x + w.width - SIZE - DOCK_MARGIN, y: w.y - b.y + w.height - GHOST_H - DOCK_MARGIN }
  }, [geo])

  useEffect(() => {
    if (dragging.current || flying || target) return
    const d = dock()
    x.set(d.x)
    y.set(d.y)
  }, [dock])

  /** Fly along a gentle arc to (tx, ty). */
  const flyTo = useCallback(async (to: Pt) => {
    const from = { x: x.get(), y: y.get() }
    const dist = Math.hypot(to.x - from.x, to.y - from.y)
    if (dist < 4) return
    setFlying(to.x >= from.x ? 'right' : 'left')
    const duration = Math.min(1.6, 0.45 + dist / 1400)
    const lift = Math.min(160, dist * 0.25)
    const mid = { x: (from.x + to.x) / 2, y: Math.min(from.y, to.y) - lift }
    await Promise.all([
      animate(x, [from.x, mid.x, to.x], { duration, ease: 'easeInOut' }),
      animate(y, [from.y, mid.y, to.y], { duration, ease: 'easeInOut' }),
    ])
    setFlying(null)
  }, [])

  // --------------------------------------------------------------- channels

  useChannel<BusEvents['ghost:state']>('ghost:state', setMain)
  useChannel<SidecarEvent>('observer:event', (e) => {
    if (e.type === 'blocked') setBlockReason(e.reason)
    else if (e.type === 'context') setBlockReason(null)
  })
  useChannel<Popup>('popup:show', async (p) => {
    // Fly in from the screen edge (PLAN §5.10) unless the ghost is busy pointing or being dragged.
    if (!target && !flying && !dragging.current && p.kind !== 'warning') {
      x.set(window.innerWidth + 20)
      y.set(dock().y - 40)
      setPopup(p)
      await flyTo(dock())
    } else setPopup(p)
    if (p.speak) void speak(p.text)
  })
  useChannel<GhostPoint>('ghost:point', async (p) => {
    const [l, t, r, b] = p.rect
    const roomLeft = l - SIZE - 12 > 0
    const to = { x: roomLeft ? l - SIZE - 12 : r + 12, y: (t + b) / 2 - GHOST_H / 2 }
    setTarget(null)
    await flyTo(to)
    setTarget(p)
    setTimeout(async () => {
      setTarget((cur) => (cur === p ? null : cur))
      await flyTo(dock())
    }, p.ms ?? POINT_MS)
  })

  useEffect(() => {
    if (!agent.caption) return
    setCaption(agent.caption)
    const t = setTimeout(() => setCaption(null), CAPTION_MS)
    return () => clearTimeout(t)
  }, [agent.caption])

  useEffect(() => {
    if (!popup) return
    const t = setTimeout(() => answer(popup, 'dismissed'), (popup.timeout_s ?? DEFAULT_TIMEOUT_S) * 1000)
    return () => clearTimeout(t)
  }, [popup])

  const answer = (p: Popup, choice: string) => {
    setPopup((cur) => (cur?.id === p.id ? null : cur))
    void tryInvoke('popup:answer', { id: p.id, choice })
  }

  const onUi = useCallback((u: AgentUi) => setAgent(u), [])
  const onVolume = useCallback((v: number) => setVolume((cur) => (Math.abs(cur - v) > 0.02 ? v : cur)), [])
  const onMicLevel = useCallback((v: number) => setMicLevel((cur) => (Math.abs(cur - v) > 0.01 ? v : cur)), [])

  // ------------------------------------------------------------ ghost state

  let state: GhostState = 'idle'
  if (flying) state = 'flying'
  else if (target) state = 'pointing'
  else if (main.state === 'alert') state = 'alert'
  else if (agent.connected && agent.speaking) state = 'speaking'
  else if (main.state === 'not_watching') state = 'not_watching'
  else if (main.state === 'thinking') state = 'thinking'
  else if (agent.connected && agent.userSpeaking) state = 'listening'

  const gaze = target ? gazeToward(target.rect, { x: x.get(), y: y.get() }) : { x: 0, y: 0 }
  const badge: GhostBadge = main.badge ?? null

  // ------------------------------------------------------------ drag / click

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    const start = { px: e.clientX, py: e.clientY, x: x.get(), y: y.get() }
    let moved = false
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - start.px
      const dy = ev.clientY - start.py
      if (!moved && Math.hypot(dx, dy) < 5) return
      moved = dragging.current = true
      x.set(start.x + dx)
      y.set(start.y + dy)
    }
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      dragging.current = false
      if (moved) home.current = { x: x.get(), y: y.get() }
      else void invoke('panel:toggle')
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  const bubble = popup ? (
    <div className={`bubble ${popup.kind === 'warning' ? 'notice' : ''}`} data-hit>
      <p>{popup.text}</p>
      {popup.choices.length > 0 && (
        <div className="choices">
          {popup.choices.slice(0, 3).map((c, i) => (
            <button key={c.id} className={i === 0 ? 'primary' : ''} onClick={() => answer(popup, c.id)}>
              {c.label}
            </button>
          ))}
        </div>
      )}
    </div>
  ) : caption ? (
    <div className="bubble caption">
      <p>{caption}</p>
    </div>
  ) : null

  return (
    <div className="overlay">
      <AgentHost onUi={onUi} onVolume={onVolume} onMicLevel={onMicLevel} onMicName={setMicName} />
      {target && <Highlight rect={target.rect} label={target.label} />}
      <motion.div className="ghost-anchor" style={{ x, y }}>
        {bubble && <div className="bubble-wrap">{bubble}</div>}
        <Ghost state={state} pose={flying ?? 'front'} gaze={gaze} badge={badge} volume={volume} size={SIZE} />
        <div
          className="ghost-hit"
          data-hit
          onPointerDown={onPointerDown}
          onContextMenu={(e) => {
            e.preventDefault()
            void tryInvoke('ghost:menu')
          }}
          title="Click: panel · Drag: move · Right-click: menu"
        />
        <div className="pills">
          {state === 'not_watching' && (
            <div className="status-pill">Not watching{blockReason ? `: ${BLOCK_LABEL[blockReason] ?? blockReason}` : ''}</div>
          )}
          {agent.connected && <MicMeter level={micLevel} name={micName} />}
        </div>
      </motion.div>
    </div>
  )
}

const QUIET_AFTER_MS = 8000

/** Live mic level while the voice agent is connected, so you can see it hears you. */
function MicMeter({ level, name }: { level: number; name: string }) {
  const lastSound = useRef(Date.now())
  const [quiet, setQuiet] = useState(false)
  if (level > 0.02) lastSound.current = Date.now()
  useEffect(() => {
    const t = setInterval(() => setQuiet(Date.now() - lastSound.current > QUIET_AFTER_MS), 1000)
    return () => clearInterval(t)
  }, [])
  const lit = Math.min(5, Math.round(Math.sqrt(level) * 9))
  const short = name.replace(/\s*\(.*\)\s*$/, '') || 'Microphone'
  return (
    <div className={`status-pill mic ${quiet ? 'quiet' : ''}`} title={quiet ? `No sound from ${name || 'the microphone'}. Pick another mic in the panel.` : name}>
      {quiet ? <MicrophoneSlashIcon size={14} /> : <MicrophoneIcon size={14} />}
      <span className="bars" aria-hidden>
        {[0, 1, 2, 3, 4].map((i) => (
          <i key={i} className={i < lit ? 'on' : ''} />
        ))}
      </span>
      <span>{quiet ? "Can't hear your mic" : short}</span>
    </div>
  )
}

function Highlight({ rect, label }: { rect: Rect; label?: string }) {
  const [l, t, r, b] = rect
  const pad = 6
  return (
    <motion.div
      className="highlight"
      style={{ left: l - pad, top: t - pad, width: r - l + pad * 2, height: b - t + pad * 2 }}
      initial={{ opacity: 0, scale: 1.3 }}
      animate={{ opacity: 1, scale: 1 }}
    >
      {label && <span>{label}</span>}
    </motion.div>
  )
}

function gazeToward(rect: Rect, ghost: Pt) {
  const cx = (rect[0] + rect[2]) / 2 - (ghost.x + SIZE / 2)
  const cy = (rect[1] + rect[3]) / 2 - (ghost.y + GHOST_H / 2)
  const d = Math.hypot(cx, cy) || 1
  return { x: cx / d, y: cy / d }
}

async function speak(text: string) {
  const res = await tryInvoke<{ audio?: string; mime?: string; error?: string }>('tts:speak', { text })
  if (!res?.audio) {
    if (res?.error) console.warn('[tts]', res.error)
    return
  }
  const audio = new Audio(`data:${res.mime};base64,${res.audio}`)
  await audio.play().catch((err) => console.warn('[tts] playback failed', err))
}
