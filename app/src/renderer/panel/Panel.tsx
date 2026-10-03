// Side panel (opened by clicking the ghost): watching status, Record/Stop, live guide steps,
// and the expert's screenshots replayed during a tutor intervention.
import { useEffect, useState } from 'react'
import type { BusEvents, Guide, SidecarEvent, WorkMap } from '@shared/contracts'
import type { ReplayCommand, SessionState } from '../../common/ipc'
import { invoke, shotUrl, tryInvoke, useChannel } from '../lib/api'
import { Ghost } from '../mascot/Ghost'
import './panel.css'

type Watch = { watching: boolean; label: string }

const BLOCK_LABEL: Record<string, string> = {
  password_manager: 'password manager',
  banking: 'banking site',
  private_window: 'private window',
  system: 'system screen',
  user_blocked: 'blocked app',
  paused: 'paused',
  off_record: 'off the record',
  self: 'Apprentice window',
}

const EMPTY: SessionState = { id: null, kind: null, phase: 'idle', started_at: null, offRecord: false, agent: null }

export default function Panel() {
  const [session, setSession] = useState<SessionState>(EMPTY)
  const [guide, setGuide] = useState<Guide | null>(null)
  const [watch, setWatch] = useState<Watch>({ watching: false, label: 'Waiting for the observer…' })
  const [ghost, setGhost] = useState<BusEvents['ghost:state']>({ state: 'idle', badge: null })
  const [replay, setReplay] = useState<ReplayCommand | null>(null)
  const [workmaps, setWorkmaps] = useState<WorkMap[] | null>(null)
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    void tryInvoke<SessionState>('session:state').then((s) => s && setSession(s))
    // Agent C may expose this; the Lesson button only shows when it does.
    void tryInvoke<WorkMap[]>('workmaps:list').then((w) => Array.isArray(w) && setWorkmaps(w))
  }, [])

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
    if (e.type === 'context') setWatch({ watching: true, label: `${e.title || e.app}` })
    else if (e.type === 'blocked') setWatch({ watching: false, label: BLOCK_LABEL[e.reason] ?? e.reason })
  })

  useEffect(() => {
    if (session.phase !== 'live' || !session.started_at) return setElapsed(0)
    const t = setInterval(() => setElapsed(Date.now() / 1000 - session.started_at!), 1000)
    return () => clearInterval(t)
  }, [session.phase, session.started_at])

  const start = (kind: 'teach' | 'quick_guide' | 'tutor', workmap_id?: string) => void invoke('session:start', { kind, workmap_id })
  const stop = () => void invoke('session:stop')
  const live = session.phase === 'live'

  return (
    <div className="panel">
      <header>
        <div className="mini-ghost">
          <Ghost state={ghost.state} badge={ghost.badge ?? null} size={64} />
        </div>
        <div className="status">
          <strong>{session.offRecord ? 'Off the record' : watch.watching ? 'Watching' : 'Not watching'}</strong>
          <span className="muted">{session.offRecord ? 'Nothing is captured' : watch.label}</span>
        </div>
      </header>

      <section className="controls">
        {live ? (
          <>
            <button className="rec on" onClick={stop}>
              ■ Stop <span className="timer">{fmt(elapsed)}</span>
            </button>
            <span className="muted">{session.kind === 'tutor' ? 'Lesson' : session.kind === 'quick_guide' ? 'Quick guide' : 'Teach session'}</span>
          </>
        ) : session.phase === 'debrief_pending' ? (
          <>
            <span className="muted">Building the Work Map draft…</span>
            <button onClick={() => void invoke('debrief:start')}>Debrief now</button>
            <button className="ghost-btn" onClick={stop}>Skip</button>
          </>
        ) : session.phase === 'debrief' ? (
          <>
            <span>Debrief in progress</span>
            <button className="ghost-btn" onClick={stop}>End</button>
          </>
        ) : (
          <>
            <button className="rec" onClick={() => start('teach')} title="Ctrl+Shift+R">
              ● Record
            </button>
            <button onClick={() => start('quick_guide')} title="Steps only, voice agent off">
              Quick guide
            </button>
            {workmaps && workmaps.length > 0 && (
              <select defaultValue="" onChange={(e) => e.target.value && start('tutor', e.target.value)}>
                <option value="" disabled>
                  Start a lesson…
                </option>
                {workmaps.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.steps[0]?.title ? `${w.id}: ${w.steps[0].title}` : w.id}
                  </option>
                ))}
              </select>
            )}
          </>
        )}
        <button
          className={`ghost-btn ${session.offRecord ? 'active' : ''}`}
          onClick={() => void invoke('session:offRecord')}
          title="Ctrl+Shift+O"
        >
          {session.offRecord ? 'Back on the record' : 'Off the record'}
        </button>
      </section>

      {replay ? (
        <Replay cmd={replay} onClose={() => setReplay(null)} />
      ) : (
        <section className="steps">
          <h3>{guide?.title || 'Steps'}</h3>
          {!guide?.steps.length && <p className="muted">{live ? 'Steps appear here as you work.' : 'Press Record and work as usual.'}</p>}
          <ol>
            {guide?.steps.map((s) => (
              <li key={s.id}>
                <div className="step-head">
                  <span className="n">{s.n}</span>
                  <span className="title">{s.title}</span>
                </div>
                {s.shot && <img src={shotUrl(s.shot)} alt="" loading="lazy" />}
                {s.quote && <blockquote>“{s.quote.text}”</blockquote>}
              </li>
            ))}
          </ol>
        </section>
      )}

      <footer>
        <button className="ghost-btn" onClick={() => void invoke('dashboard:open')}>
          Open dashboard
        </button>
        <button className="ghost-btn" onClick={() => void invoke('app:quit')}>
          Quit
        </button>
      </footer>
    </div>
  )
}

function Replay({ cmd, onClose }: { cmd: ReplayCommand; onClose: () => void }) {
  const [i, setI] = useState(0)
  const steps = cmd.steps.filter((s) => s.shot)
  useEffect(() => {
    setI(0)
    if (steps.length < 2) return
    const t = setInterval(() => setI((n) => (n + 1) % steps.length), 2500)
    return () => clearInterval(t)
  }, [cmd])
  const s = steps[i] ?? cmd.steps[0]
  return (
    <section className="replay">
      <h3>
        How the expert did it <button className="ghost-btn" onClick={onClose}>✕</button>
      </h3>
      {s?.shot && <img src={shotUrl(s.shot)} alt="" />}
      <p>
        <strong>{s?.n}.</strong> {s?.title}
      </p>
      {s?.quote && <blockquote>“{s.quote.text}”</blockquote>}
      {steps.length > 1 && (
        <p className="muted">
          {i + 1} / {steps.length}
        </p>
      )}
    </section>
  )
}

function fmt(s: number) {
  const m = Math.floor(s / 60)
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`
}
