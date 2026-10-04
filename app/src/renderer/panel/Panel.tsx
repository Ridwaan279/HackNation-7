// Side panel (opened by clicking the ghost): watching status, Record/Stop, the live step trail,
// and the expert's screenshots replayed during a tutor intervention.
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useEffect, useRef, useState } from 'react'
import {
  CaretLeftIcon,
  CaretRightIcon,
  ListNumbersIcon,
  MicrophoneIcon,
  MicrophoneSlashIcon,
  PowerIcon,
  RecordIcon,
  SquaresFourIcon,
  StopIcon,
  XIcon,
} from '@phosphor-icons/react'
import type { BusEvents, Guide, GuideStep, SidecarEvent, WorkMap } from '@shared/contracts'
import type { ReplayCommand, SessionState } from '../../common/ipc'
import { invoke, shotUrl, tryInvoke, useChannel } from '../lib/api'
import { getMic, setMic, useMics } from '../lib/mic'
import { ModeSwitch, type Mode } from '../lib/ModeSwitch'
import { Ghost } from '../mascot/Ghost'
import './panel.css'

type Watch = { watching: boolean; detail: string }

/** Why the apprentice isn't watching, as the end of a sentence. */
const BLOCK_DETAIL: Record<string, string> = {
  password_manager: 'Password managers are always private.',
  banking: 'Banking sites are always private.',
  private_window: 'Private browsing windows are always private.',
  system: 'System screens are always private.',
  user_blocked: "You've blocked this app.",
  paused: 'Watching is paused.',
  off_record: "You're off the record.",
  self: "That's the Apprentice's own window.",
}

const EMPTY: SessionState = { id: null, kind: null, phase: 'idle', started_at: null, offRecord: false, agent: null }

export default function Panel() {
  const [session, setSession] = useState<SessionState>(EMPTY)
  const [guide, setGuide] = useState<Guide | null>(null)
  const [watch, setWatch] = useState<Watch>({ watching: false, detail: 'Waiting for the observer to start.' })
  const [ghost, setGhost] = useState<BusEvents['ghost:state']>({ state: 'idle', badge: null })
  const [replay, setReplay] = useState<ReplayCommand | null>(null)
  const [workmaps, setWorkmaps] = useState<WorkMap[] | null>(null)
  const [mode, setMode] = useState<Mode>('expert')

  useEffect(() => {
    void tryInvoke<SessionState>('session:state').then((s) => s && setSession(s))
    // Agent C may expose this; the lesson picker only shows when it does.
    void tryInvoke<WorkMap[]>('workmaps:list').then((w) => Array.isArray(w) && setWorkmaps(w))
    void tryInvoke<{ mode?: Mode }>('settings:get').then((s) => s?.mode && setMode(s.mode))
  }, [])
  useChannel<{ mode?: Mode }>('settings:updated', (s) => s?.mode && setMode(s.mode))
  useChannel<WorkMap>('workmap:updated', () => void tryInvoke<WorkMap[]>('workmaps:list').then((w) => Array.isArray(w) && setWorkmaps(w)))

  useChannel<SessionState>('session:state', setSession)
  useChannel<BusEvents['ghost:state']>('ghost:state', setGhost)
  useChannel<ReplayCommand>('panel:replay', setReplay)
  useChannel<Guide>('guide:updated', (g) => {
    if (!session.id || g.session === session.id) setGuide(g)
  })
  useChannel<BusEvents['session:started']>('session:started', () => {
    setGuide(null)
    setReplay(null)
  })
  useChannel<SidecarEvent>('observer:event', (e) => {
    if (e.type === 'context') setWatch({ watching: true, detail: e.title || e.app })
    else if (e.type === 'blocked') setWatch({ watching: false, detail: BLOCK_DETAIL[e.reason] ?? 'This window is private.' })
  })

  const live = session.phase === 'live'
  const watching = watch.watching && !session.offRecord

  return (
    <div className="panel">
      <div className="titlebar">Apprentice</div>

      <header className="status">
        <div className="status-ghost" aria-hidden>
          <Ghost state={session.offRecord ? 'not_watching' : ghost.state} badge={ghost.badge ?? null} size={84} />
        </div>
        <div className="status-text">
          <h1 className="t-subtitle">{session.offRecord ? 'Off the record' : watching ? 'Watching' : 'Not watching'}</h1>
          <p title={watch.detail}>{session.offRecord ? 'Nothing is captured until you resume.' : watch.detail}</p>
        </div>
      </header>

      <div className="panel-mode">
        <ModeSwitch mode={mode} size="compact" disabled={session.phase !== 'idle'} onChange={(m) => { setMode(m); void tryInvoke('settings:set', { mode: m }) }} />
      </div>
      <Controls session={session} workmaps={workmaps} mode={mode} />
      <MicPicker />

      {replay ? <Replay cmd={replay} onClose={() => setReplay(null)} /> : <StepTrail guide={guide} live={live} />}

      <footer>
        <button className="quiet" onClick={() => void invoke('dashboard:open')}>
          <SquaresFourIcon size={16} /> Open dashboard
        </button>
        <button className="quiet" onClick={() => void invoke('app:quit')}>
          <PowerIcon size={16} /> Quit
        </button>
      </footer>
    </div>
  )
}

// ------------------------------------------------------------------ controls

function Controls({ session, workmaps, mode }: { session: SessionState; workmaps: WorkMap[] | null; mode: Mode }) {
  const start = (kind: 'teach' | 'quick_guide' | 'tutor', workmap_id?: string) => void invoke('session:start', { kind, workmap_id })
  const stop = () => void invoke('session:stop')
  const offRecord = () => void invoke('session:offRecord')

  if (session.offRecord) {
    return (
      <section className="controls">
        <div className="notice">
          <MicrophoneSlashIcon size={18} />
          <span>Screen and microphone are paused. This gap is marked in the timeline.</span>
        </div>
        <button className="primary" onClick={offRecord}>
          Resume
        </button>
      </section>
    )
  }

  if (session.phase === 'live') {
    return (
      <section className="controls">
        <button className="stop" onClick={stop} title="Ctrl+Shift+R">
          <StopIcon size={16} weight="fill" /> Stop <Timer since={session.started_at} />
        </button>
        <span className="session-kind">
          {session.kind === 'tutor' ? 'Lesson in progress' : session.kind === 'quick_guide' ? 'Recording steps' : 'Teaching the apprentice'}
        </span>
        <button className="quiet push" onClick={offRecord} title="Ctrl+Shift+O">
          <MicrophoneSlashIcon size={16} /> Off the record
        </button>
      </section>
    )
  }

  if (session.phase === 'debrief_pending') {
    return (
      <section className="controls stacked">
        <p>Turning this session into a Work Map. The debrief starts when it's ready.</p>
        <div className="progress" aria-hidden />
        <div className="row">
          <button className="primary" onClick={() => void invoke('debrief:start')}>
            Start debrief now
          </button>
          <button className="quiet" onClick={stop}>
            Skip debrief
          </button>
        </div>
      </section>
    )
  }

  if (session.phase === 'debrief') {
    return (
      <section className="controls">
        <span className="session-kind">Debrief in progress</span>
        <button className="quiet push" onClick={stop}>
          End debrief
        </button>
      </section>
    )
  }

  if (mode === 'newhire') {
    return (
      <section className="controls">
        {workmaps && workmaps.length > 0 ? (
          <select defaultValue="" aria-label="Start a lesson" onChange={(e) => e.target.value && start('tutor', e.target.value)}>
            <option value="" disabled>
              Start a lesson
            </option>
            {workmaps.map((w) => (
              <option key={w.id} value={w.id}>
                {w.steps.length ? `${w.steps[0].title} (${w.steps.length} steps)` : w.id}
              </option>
            ))}
          </select>
        ) : (
          <span className="session-kind">No tasks to learn yet. An expert records one first.</span>
        )}
        <button className="quiet push" onClick={offRecord} title="Ctrl+Shift+O" aria-label="Go off the record">
          <MicrophoneSlashIcon size={16} />
        </button>
      </section>
    )
  }

  return (
    <section className="controls">
      <button className="record" onClick={() => start('teach')} title="Ctrl+Shift+R">
        <RecordIcon size={16} weight="fill" /> Record
      </button>
      <button className="secondary" onClick={() => start('quick_guide')} title="Record steps with the voice agent off">
        <ListNumbersIcon size={16} /> Steps only
      </button>
      <button className="quiet push" onClick={offRecord} title="Ctrl+Shift+O" aria-label="Go off the record">
        <MicrophoneSlashIcon size={16} />
      </button>
    </section>
  )
}

/** Which microphone the voice agent listens to. Applies immediately, also mid-conversation. */
function MicPicker() {
  const mics = useMics()
  const [mic, setChoice] = useState(getMic)
  if (mics.length < 2) return null
  const known = !mic || mics.some((m) => m.deviceId === mic)
  return (
    <label className="mic-picker">
      <MicrophoneIcon size={16} aria-hidden />
      <span>Microphone</span>
      <select
        value={known ? mic : ''}
        onChange={(e) => {
          setMic(e.target.value)
          setChoice(e.target.value)
        }}
      >
        <option value="">Windows default</option>
        {mics.map((m) => (
          <option key={m.deviceId} value={m.deviceId}>
            {m.label}
          </option>
        ))}
      </select>
    </label>
  )
}

function Timer({ since }: { since: number | null }) {
  const [now, setNow] = useState(Date.now() / 1000)
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() / 1000), 1000)
    return () => clearInterval(t)
  }, [])
  const s = Math.max(0, now - (since ?? now))
  return <span className="timer">{`${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`}</span>
}

// ---------------------------------------------------------------- step trail

function StepTrail({ guide, live }: { guide: Guide | null; live: boolean }) {
  const steps = guide?.steps ?? []
  const reduce = useReducedMotion()
  // Only steps that arrive while the panel is open get the landing animation.
  const seen = useRef<Set<string> | null>(null)
  if (seen.current === null) seen.current = new Set(steps.map((s) => s.id))
  const end = useRef<HTMLDivElement>(null)
  const newest = steps[steps.length - 1]?.id

  useEffect(() => {
    if (live && newest) end.current?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'end' })
  }, [newest, live, reduce])

  if (!steps.length) {
    return (
      <section className="trail empty">
        <h2>{live ? 'Waiting for your first click' : 'No steps yet'}</h2>
        <p>
          {live
            ? 'Work as you normally do. Each click and each field you fill in becomes a step here.'
            : 'Press Record and do the task once. The apprentice writes the guide as you go, and asks why at natural pauses.'}
        </p>
        {!live && (
          <p className="hint">
            <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>R</kbd> starts and stops recording from any app.
          </p>
        )}
      </section>
    )
  }

  return (
    <section className="trail">
      <h2>
        {guide?.title || 'Steps'}
        <span>{steps.length === 1 ? '1 step' : `${steps.length} steps`}</span>
      </h2>
      <ol>
        {steps.map((s) => {
          const fresh = !seen.current!.has(s.id)
          if (fresh) seen.current!.add(s.id)
          return <StepItem key={s.id} step={s} fresh={fresh && !reduce} newest={live && s.id === newest} />
        })}
      </ol>
      <div ref={end} />
    </section>
  )
}

function StepItem({ step, fresh, newest }: { step: GuideStep; fresh: boolean; newest: boolean }) {
  return (
    <motion.li
      className={newest ? 'newest' : undefined}
      initial={fresh ? { opacity: 0, y: 10 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: 'spring', stiffness: 260, damping: 26 }}
    >
      <motion.span
        className="knot"
        initial={fresh ? { scale: 0.4 } : false}
        animate={{ scale: 1 }}
        transition={{ type: 'spring', stiffness: 420, damping: 18, delay: fresh ? 0.08 : 0 }}
      >
        {step.n}
      </motion.span>
      <div className="step-body">
        <p className="step-title">{step.title}</p>
        {step.shot && <img src={shotUrl(step.shot)} alt={step.screen_moment || step.title} loading="lazy" />}
        {step.quote && <blockquote>{step.quote.text}</blockquote>}
      </div>
    </motion.li>
  )
}

// --------------------------------------------------------------------- replay

function Replay({ cmd, onClose }: { cmd: ReplayCommand; onClose: () => void }) {
  const steps = cmd.steps.filter((s) => s.shot)
  const [i, setI] = useState(0)
  useEffect(() => {
    setI(0)
    if (steps.length < 2) return
    const t = setInterval(() => setI((n) => (n + 1) % steps.length), 3500)
    return () => clearInterval(t)
  }, [cmd])
  const s = steps[i] ?? cmd.steps[0]
  const go = (d: number) => setI((n) => (n + d + steps.length) % steps.length)

  return (
    <section className="replay">
      <h2>
        How the expert did this step
        <button className="icon" onClick={onClose} aria-label="Close replay">
          <XIcon size={16} />
        </button>
      </h2>
      <AnimatePresence mode="wait">
        {s?.shot && (
          <motion.img key={s.id} src={shotUrl(s.shot)} alt={s.screen_moment || s.title} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
        )}
      </AnimatePresence>
      <p className="step-title">
        {s?.n}. {s?.title}
      </p>
      {s?.quote && <blockquote>{s.quote.text}</blockquote>}
      {steps.length > 1 && (
        <div className="row pager">
          <button className="icon" onClick={() => go(-1)} aria-label="Previous screenshot">
            <CaretLeftIcon size={16} />
          </button>
          <span>
            {i + 1} of {steps.length}
          </span>
          <button className="icon" onClick={() => go(1)} aria-label="Next screenshot">
            <CaretRightIcon size={16} />
          </button>
        </div>
      )}
    </section>
  )
}
