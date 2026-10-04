// New-hire home: pick a task the expert recorded and do it for real, with the ghost watching.
import { useCallback, useEffect, useState } from 'react'
import { PlayIcon, StopIcon } from '@phosphor-icons/react'
import type { Guide, WorkMap } from '@shared/contracts'
import { errorText, type DashboardBridge, type SessionInfo } from './bridge'

export function LearnPage({ bridge, session, openProgress }: {
  bridge: DashboardBridge
  session: SessionInfo
  openProgress: () => void
}) {
  const [maps, setMaps] = useState<WorkMap[] | null>(null)
  const [guides, setGuides] = useState<Guide[]>([])
  const [error, setError] = useState('')

  const reload = useCallback(async () => {
    try {
      const [m, g] = await Promise.all([bridge.invoke('workmaps:list', {}), bridge.invoke('guides:list', {})])
      setMaps(m)
      setGuides(g)
      setError('')
    } catch (e) {
      setMaps([])
      setError(errorText(e, 'Could not load the tasks.'))
    }
  }, [bridge])
  useEffect(() => {
    void reload()
    return bridge.on('workmap:updated', () => void reload())
  }, [bridge, reload])

  const title = (m: WorkMap) => guides.find((g) => g.id === m.guide)?.title.replace(/ guide$/i, '') || 'Recorded task'
  const run = (p: Promise<unknown>) => void p.then(() => setError('')).catch((e) => setError(errorText(e)))
  const inLesson = session.kind === 'tutor' && session.phase === 'live'
  const lessonMap = inLesson ? maps?.find((m) => m.id === session.workmap_id) : undefined

  if (inLesson) {
    return <section className="home">
      <h1>{lessonMap ? title(lessonMap) : 'Lesson in progress'}</h1>
      <p>Do the task in the real app. If you are about to make a mistake, the ghost stops you before it is saved and shows how the expert did it.</p>
      <button className="big-action stop" onClick={() => run(bridge.invoke('session:stop', {}))}>
        <StopIcon size={22} weight="fill" /> Finish lesson
      </button>
      <p className="home-meta">Your report appears under Progress when you finish.</p>
      {error && <p className="home-error" role="alert">{error}</p>}
    </section>
  }

  const recordingNow = session.phase !== 'idle'
  return <section className="home wide">
    <h1>Learn a task</h1>
    <p>Pick a task, then do it in the real app. The ghost watches and steps in before a mistake is saved.</p>
    {maps === null ? <p className="home-meta" role="status">Loading tasks…</p>
      : maps.length === 0 ? <div className="home-empty">
        <h2>Nothing to learn yet</h2>
        <p>An expert records a task on the Expert side first. It shows up here once it has a Work Map.</p>
      </div>
      : <ul className="task-list">
        {maps.map((m) => <li key={m.id}>
          <div>
            <strong>{title(m)}</strong>
            <span>{m.steps.length === 1 ? '1 step' : `${m.steps.length} steps`}{m.status === 'draft' ? ', still a draft' : ''}</span>
          </div>
          <button className="primary" disabled={recordingNow} onClick={() => run(bridge.invoke('session:start', { kind: 'tutor', workmap_id: m.id }))}>
            <PlayIcon size={16} weight="fill" /> Start lesson
          </button>
        </li>)}
      </ul>}
    <div className="home-actions"><button className="quiet" onClick={openProgress}>See your progress</button></div>
    {error && <p className="home-error" role="alert">{error}</p>}
  </section>
}
