// The ghost mascot (PLAN §5.10): one SVG, no rasters, animated with Framer Motion.
import { motion } from 'framer-motion'
import { useEffect, useId, useState } from 'react'
import type { GhostState } from '@shared/contracts'

export type GhostPose = 'front' | 'left' | 'right'
export type GhostBadge = 'recording' | 'vision' | null

export interface GhostProps {
  state: GhostState
  /** Direction of travel while flying. */
  pose?: GhostPose
  /** Where the eyes look, each axis -1..1. */
  gaze?: { x: number; y: number }
  badge?: GhostBadge
  /** Agent output volume 0..1; drives the glow while speaking. */
  volume?: number
  /** Rendered width in px (the body is ~55% of it; the rest is room for glow and speed lines). */
  size?: number
}

// Rounded dome, sides flaring slightly, three-bump hem. Body box ≈ 0..120 × 0..126.
const BODY =
  'M60 6C88 6 108 28 108 60L111 106C112 124 82 128 77 110C73 126 47 126 43 110C38 128 8 124 9 106L12 60C12 28 32 6 60 6Z'
const VIEW_W = 220
const VIEW_H = 165
const SPEED_LINES = [
  { y: 42, x1: -38, x2: -4 },
  { y: 58, x1: -48, x2: -12 },
  { y: 74, x1: -30, x2: -2 },
  { y: 90, x1: -42, x2: -10 },
]

/** Two drop-shadows each, so Framer can interpolate between them. */
function glowFor(state: GhostState, volume: number, pulse = false): string {
  if (state === 'not_watching') return 'drop-shadow(0 0 5px rgba(150,150,170,0.5)) drop-shadow(0 0 12px rgba(120,120,140,0.3))'
  if (state === 'alert') return 'drop-shadow(0 0 14px rgba(255,110,190,0.95)) drop-shadow(0 0 32px rgba(255,140,200,0.65))'
  const v = state === 'speaking' ? Math.min(1, volume * 1.6) : pulse ? 0.55 : 0
  const r = 9 + v * 20
  return `drop-shadow(0 0 ${r.toFixed(1)}px rgba(120,150,255,${(0.7 + v * 0.3).toFixed(2)})) drop-shadow(0 0 ${(r * 2.2).toFixed(1)}px rgba(170,120,240,${(0.35 + v * 0.45).toFixed(2)}))`
}

/** Blink every 4–7 s. */
function useBlink(enabled: boolean) {
  const [closed, setClosed] = useState(false)
  useEffect(() => {
    if (!enabled) return
    let timer: ReturnType<typeof setTimeout>
    const loop = () => {
      timer = setTimeout(() => {
        setClosed(true)
        timer = setTimeout(() => {
          setClosed(false)
          loop()
        }, 130)
      }, 4000 + Math.random() * 3000)
    }
    loop()
    return () => clearTimeout(timer)
  }, [enabled])
  return closed
}

export function Ghost({ state, pose = 'front', gaze = { x: 0, y: 0 }, badge = null, volume = 0, size = 160 }: GhostProps) {
  const uid = useId().replace(/[^\w-]/g, '')
  const flying = state === 'flying' && pose !== 'front'
  const asleep = state === 'not_watching'
  const blink = useBlink(!asleep)

  let eyeX = gaze.x * 4 + (flying ? (pose === 'right' ? 7 : -7) : 0)
  let eyeY = gaze.y * 4
  if (state === 'thinking') {
    eyeX = -5
    eyeY = -6
  }

  const bob =
    state === 'alert'
      ? { animate: { y: [0, -14, 0, -6, 0] }, transition: { duration: 0.8, repeat: 2 } }
      : flying
        ? { animate: { y: 0 }, transition: { duration: 0.2 } }
        : { animate: { y: [0, -6, 0] }, transition: { duration: 4, repeat: Infinity, ease: 'easeInOut' as const } }

  const glow =
    state === 'listening'
      ? { animate: { filter: [glowFor(state, 0), glowFor(state, 0, true), glowFor(state, 0)] }, transition: { duration: 1.6, repeat: Infinity } }
      : { animate: { filter: glowFor(state, volume) }, transition: { duration: state === 'speaking' ? 0.08 : 0.4 } }

  return (
    <motion.div style={{ width: size, height: (size * VIEW_H) / VIEW_W }} {...bob}>
      <motion.div
        style={{ width: '100%', height: '100%' }}
        animate={{ rotate: flying ? (pose === 'right' ? 12 : -12) : 0, opacity: asleep ? 0.4 : 1, ...glow.animate }}
        transition={{ rotate: { type: 'spring', stiffness: 140, damping: 16 }, opacity: { duration: 0.4 }, filter: glow.transition }}
      >
        <svg viewBox={`-50 -15 ${VIEW_W} ${VIEW_H}`} width="100%" height="100%" overflow="visible">
          <defs>
            <linearGradient id={`body-${uid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={asleep ? '#9aa3b5' : '#7CC7F4'} />
              <stop offset="0.55" stopColor={asleep ? '#9f97b3' : '#B38DE8'} />
              <stop offset="1" stopColor={asleep ? '#a99aae' : state === 'alert' ? '#FF8FD2' : '#F59FDF'} />
            </linearGradient>
            <radialGradient id={`shine-${uid}`} cx="0.35" cy="0.2" r="0.6">
              <stop offset="0" stopColor="#fff" stopOpacity="0.55" />
              <stop offset="1" stopColor="#fff" stopOpacity="0" />
            </radialGradient>
            <linearGradient id={`speed-${uid}`} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stopColor="#F59FDF" stopOpacity="0" />
              <stop offset="0.4" stopColor="#B38DE8" />
              <stop offset="1" stopColor="#7CC7F4" />
            </linearGradient>
            <filter id={`eyeglow-${uid}`} x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="2.2" result="b" />
              <feMerge>
                <feMergeNode in="b" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {flying && (
            <g transform={pose === 'left' ? 'translate(120 0) scale(-1 1)' : undefined}>
              {SPEED_LINES.map((l, i) => (
                <motion.line
                  key={i}
                  x1={l.x1}
                  x2={l.x2}
                  y1={l.y}
                  y2={l.y}
                  stroke={`url(#speed-${uid})`}
                  strokeWidth={5}
                  strokeLinecap="round"
                  animate={{ x: [0, -8, 0], opacity: [0.9, 0.5, 0.9] }}
                  transition={{ duration: 0.35 + i * 0.07, repeat: Infinity }}
                />
              ))}
            </g>
          )}

          <path d={BODY} fill={`url(#body-${uid})`} />
          <motion.path
            d={BODY}
            fill={`url(#shine-${uid})`}
            animate={{ opacity: state === 'thinking' ? [0.3, 0.9, 0.3] : 0.7 }}
            transition={state === 'thinking' ? { duration: 1.2, repeat: Infinity } : { duration: 0.3 }}
          />

          <motion.g animate={{ x: eyeX, y: eyeY }} transition={{ type: 'spring', stiffness: 120, damping: 14 }} filter={`url(#eyeglow-${uid})`}>
            {[46, 74].map((cx) => (
              <motion.ellipse
                key={cx}
                cx={cx}
                cy={55}
                rx={asleep ? 8 : 7}
                fill="#fff"
                initial={false}
                animate={{ ry: asleep ? 1.6 : blink ? 1.2 : 10.5 }}
                transition={{ duration: blink ? 0.06 : 0.12 }}
              />
            ))}
          </motion.g>

          {badge === 'recording' && (
            <motion.circle cx={104} cy={14} r={7} fill="#ff4d6d" stroke="#fff" strokeWidth={2} animate={{ opacity: [1, 0.45, 1] }} transition={{ duration: 1.4, repeat: Infinity }} />
          )}
          {badge === 'vision' && (
            <g transform="translate(92 4)">
              <rect x={0} y={4} width={22} height={15} rx={4} fill="#1e1b3a" stroke="#fff" strokeWidth={1.8} />
              <rect x={7} y={1} width={8} height={4} rx={1.5} fill="#fff" />
              <circle cx={11} cy={11.5} r={4} fill="none" stroke="#7CC7F4" strokeWidth={2} />
            </g>
          )}
        </svg>
      </motion.div>
    </motion.div>
  )
}
