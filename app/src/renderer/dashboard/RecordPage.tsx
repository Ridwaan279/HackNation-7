// Expert home: one big action. Record a task; the ghost writes the steps and asks why at pauses.
import { useEffect, useState } from 'react'
import { MicrophoneSlashIcon, RecordIcon, StopIcon } from '@phosphor-icons/react'
import type { Guide } from '@shared/contracts'
import { errorText, type DashboardBridge, type SessionInfo } from './bridge'

function useClock(since: number | null) {
  const [now, setNow] = useState(Date.now() / 1000)
  useEffect(() => {
    if (!since) return
    const t = setInterval(() => setNow(Date.now() / 1000), 1000)
    return () => clearInterval(t)
  }, [since])
  const s = Math.max(0, Math.floor(now - (since ?? now)))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function RecordPage({ bridge, session, openRecordings }: {
  bridge: DashboardBridge
  session: SessionInfo
  openRecordings: () => void
}) {
  const [steps, setSteps] = useState(0)
  const [error, setError] = useState('')
  const live = session.phase === 'live' && session.kind !== 'tutor'
  const clock = useClock(live ? session.started_at : null)

  useEffect(() => bridge.on('guide:updated', (g) => {
    const guide = g as Guide
    if (guide.session && guide.session === session.id) setSteps(guide.steps.length)
  }), [bridge, session.id])
  useEffect(() => { if (!live) setSteps(0) }, [live])

  const run = (p: Promise<unknown>) => void p.then(() => setError('')).catch((e) => setError(errorText(e)))
  const start = (kind: 'teach' | 'quick_guide') => run(bridge.invoke('session:start', { kind }))

  if (session.kind === 'tutor' && session.phase === 'live') {
    return <section className="home"><h1>A lesson is running</h1><p>Stop it on the New hire side before recording.</p></section>
  }

  if (session.phase === 'debrief_pending' || session.phase === 'debrief') {
    const waiting = session.phase === 'debrief_pending'
    return <section className="home">
      <h1>{waiting ? 'Building the Work Map' : 'Debrief in progress'}</h1>
      <p>{waiting
        ? 'The apprentice is turning what you did into a Work Map. Then it asks you a few questions about what it could not see.'
        : 'Answer the ghost’s questions out loud. It ends by explaining the task back to you to check it understood.'}</p>
      {waiting && <div className="home-progress" aria-hidden />}
      <div className="home-actions">
        {waiting && <button className="primary" onClick={() => run(bridge.invoke('debrief:start', {}))}>Start debrief now</button>}
        <button className="quiet" onClick={() => run(bridge.invoke('session:stop', {}))}>{waiting ? 'Skip debrief' : 'End debrief'}</button>
      </div>
      {error && <p className="home-error" role="alert">{error}</p>}
    </section>
  }

  if (live) {
    return <section className="home">
      <h1>{session.offRecord ? 'Off the record' : 'Recording'}</h1>
      <p>{session.offRecord
        ? 'Nothing is captured until you resume. The gap is marked in the recording.'
        : session.kind === 'quick_guide'
          ? 'Do the task as usual. Every click and field you fill in becomes a step.'
          : 'Start by saying what you are going to show, then do the task as usual. The ghost listens first and asks why when you pause.'}</p>
      <button className="big-action stop" onClick={() => run(bridge.invoke('session:stop', {}))}>
        <StopIcon size={22} weight="fill" /> Stop <span className="clock">{clock}</span>
      </button>
      <p className="home-meta">{steps === 1 ? '1 step so far' : `${steps} steps so far`}</p>
      <div className="home-actions">
        <button className="quiet" onClick={() => run(bridge.invoke('session:offRecord', {}))}>
          <MicrophoneSlashIcon size={16} /> {session.offRecord ? 'Back on the record' : 'Go off the record'}
        </button>
      </div>
      {error && <p className="home-error" role="alert">{error}</p>}
    </section>
  }

  return <section className="home">
    <h1>Teach the apprentice a task</h1>
    <p>Press Record, say in a sentence or two what you are going to show, then do the task the way you always do. The ghost writes the steps and saves its questions for your pauses.</p>
    <button className="big-action" onClick={() => start('teach')}>
      <RecordIcon size={22} weight="fill" /> Record
    </button>
    <div className="home-actions">
      <button className="quiet" onClick={() => start('quick_guide')}>Record steps only, without questions</button>
      <button className="quiet" onClick={openRecordings}>See your recordings</button>
    </div>
    <p className="home-meta"><kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>R</kbd> starts and stops recording from any app.</p>
    {error && <p className="home-error" role="alert">{error}</p>}
  </section>
}
