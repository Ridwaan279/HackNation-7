// Expert home: one big action. Record a task; the ghost writes the steps and asks why at pauses.
import { useEffect, useRef, useState } from 'react'
import { ArrowRightIcon, MicrophoneSlashIcon, RecordIcon, StopIcon } from '@phosphor-icons/react'
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

export function RecordPage({ bridge, session, openRecordings, requestNew }: {
  bridge: DashboardBridge
  session: SessionInfo
  openRecordings: () => void
  requestNew?: boolean
}) {
  const [steps, setSteps] = useState(0)
  const [error, setError] = useState('')
  const [task, setTask] = useState('')
  const [kind, setKind] = useState<'teach' | 'quick_guide'>('teach')
  const taskInput = useRef<HTMLInputElement>(null)
  const live = session.phase === 'live' && session.kind !== 'tutor'
  const clock = useClock(live ? session.started_at : null)

  useEffect(() => bridge.on('guide:updated', (g) => {
    const guide = g as Guide
    if (guide.session && guide.session === session.id) setSteps(guide.steps.length)
  }), [bridge, session.id])
  useEffect(() => { if (!live) setSteps(0) }, [live])
  useEffect(() => { if (requestNew && session.phase === 'idle') taskInput.current?.focus() }, [requestNew, session.phase])

  const run = (p: Promise<unknown>) => void p.then(() => setError('')).catch((e) => setError(errorText(e)))
  const start = () => {
    const label = task.trim()
    if (!label) { setError('Give this recording a task name first.'); taskInput.current?.focus(); return }
    run(bridge.invoke('session:start', { kind, task: label }))
  }

  if (session.kind === 'tutor' && session.phase === 'live') {
    return <section className="home"><h1>A lesson is running</h1><p>Stop it on the New hire side before recording.</p></section>
  }

  if (session.phase === 'debrief_pending' || session.phase === 'debrief') {
    const waiting = session.phase === 'debrief_pending'
    return <section className="home">
      <h1>{waiting ? 'Building the Work Map' : 'Debrief in progress'}</h1>
      <p>{waiting
        ? 'Protégé is turning what you did into a Work Map. Then it asks you a few questions about what it could not see.'
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
    return <section className="home record-home">
      <span className="workspace-kicker">{session.offRecord ? 'PAUSED' : 'RECORDING IN PROGRESS'}</span>
      <h1>{session.task || (session.offRecord ? 'Off the record' : 'Recording')}</h1>
      <p>{session.offRecord
        ? 'Nothing is captured until you resume. The gap is marked in the recording.'
        : session.kind === 'quick_guide'
          ? 'Do the task as usual. Every click and field you fill in becomes a step.'
          : 'Start by saying what you are going to show, then do the task as usual. The ghost listens first and asks why when you pause.'}</p>
      <button className="big-action stop" onClick={() => run(bridge.invoke('session:stop', {}))}>
        <StopIcon size={22} weight="fill" /> Stop <span className="clock">{clock}</span>
      </button>
      <p className="home-meta">{steps === 1 ? '1 step captured' : `${steps} steps captured`}</p>
      <div className="home-actions">
        <button className="quiet" onClick={() => run(bridge.invoke('session:offRecord', {}))}>
          <MicrophoneSlashIcon size={16} /> {session.offRecord ? 'Back on the record' : 'Go off the record'}
        </button>
      </div>
      {error && <p className="home-error" role="alert">{error}</p>}
    </section>
  }

  return <section className="record-layout">
    <div className="record-intro"><span className="workspace-kicker">CAPTURE A PROCESS</span>
      <h1>Show how the work gets done.</h1>
      <p>Give the task a name before recording. Protégé uses it to label the guide, shape its questions, and help new hires find the right training later.</p>
      <div className="record-sequence"><span>01 <strong>Name the task</strong></span><span>02 <strong>Work and explain</strong></span><span>03 <strong>Review the guide</strong></span></div>
    </div>
    <form className="record-card" onSubmit={(e) => { e.preventDefault(); start() }}>
      <span className="record-card-label"><RecordIcon size={16} weight="fill" /> NEW RECORDING</span>
      <h2>What is this recording about?</h2>
      <p>Use the name your team would search for later.</p>
      <label htmlFor="record-task">Task name</label>
      <input id="record-task" ref={taskInput} value={task} maxLength={120} onChange={(e) => setTask(e.target.value)} placeholder="e.g. Approve an equipment invoice" required />
      <fieldset className="record-kind"><legend>Capture mode</legend>
        <label><input type="radio" name="capture-kind" checked={kind === 'teach'} onChange={() => setKind('teach')} /><span><strong>Guided recording</strong><small>Ghost asks why at natural pauses.</small></span></label>
        <label><input type="radio" name="capture-kind" checked={kind === 'quick_guide'} onChange={() => setKind('quick_guide')} /><span><strong>Steps only</strong><small>Capture clicks and fields without questions.</small></span></label>
      </fieldset>
      <button className="primary record-submit" disabled={!task.trim()}>Start recording <ArrowRightIcon size={17} /></button>
      <p className="record-privacy">Passwords and blocked apps are never captured. <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>R</kbd> opens this screen from any app.</p>
      {error && <p className="home-error" role="alert">{error}</p>}
    </form>
    <button className="quiet record-browse" onClick={openRecordings}>Browse existing recordings <ArrowRightIcon size={16} /></button>
  </section>
}
