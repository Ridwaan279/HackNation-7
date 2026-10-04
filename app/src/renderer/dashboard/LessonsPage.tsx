import { useCallback, useEffect, useState } from 'react'
import type { MasteryReport } from '@shared/contracts'
import { errorText, when, type DashboardBridge } from './bridge'

const OUTCOME: Record<string, string> = { alone: 'Done alone', hint: 'After a hint', caught: 'Caught by a guardrail', not_reached: 'Not reached' }

export function LessonsPage({ bridge, params }: { bridge?: DashboardBridge; params: URLSearchParams }) {
  const [reports, setReports] = useState<MasteryReport[]>([])
  const [selected, setSelected] = useState(params.get('session') ?? '')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const reload = useCallback(async () => {
    if (!bridge) { setLoading(false); return }
    try {
      const list = await bridge.invoke('mastery:list', {})
      setReports(list); setError('')
      setSelected((current) => list.some((r) => r.session === current) ? current : list[0]?.session ?? '')
    } catch (failure) { setError(errorText(failure, 'Unable to load lessons.')) }
    finally { setLoading(false) }
  }, [bridge])
  useEffect(() => {
    void reload()
    if (!bridge) return
    return bridge.on('mastery:updated', (payload) => {
      const r = payload as MasteryReport
      setReports((previous) => [r, ...previous.filter((x) => x.session !== r.session)])
      setSelected(r.session)
    })
  }, [bridge, reload])
  useEffect(() => { if (params.get('session')) setSelected(params.get('session')!) }, [params])
  const report = reports.find((r) => r.session === selected)
  return <>
    <div className="guide-page-heading"><div><p className="guide-eyebrow">Teach / Lessons</p><h1>Did the new hire learn it?</h1><p>Each step of the Work Map: done alone, after a hint, or caught by a guardrail before it was saved.</p></div><button onClick={() => void reload()}>Reload</button></div>
    {error && <div className="guide-error" role="alert">{error}</div>}
    {!bridge ? <div className="guide-empty"><h2>Open this workspace in Protégé</h2></div> : loading ? <div className="guide-empty" role="status">Loading…</div> : !report ? <div className="guide-empty"><h2>No lessons yet.</h2><p>Start a lesson from a Work Map. The mastery report appears here when the lesson ends.</p></div> :
      <div className="guide-workspace">
        <aside className="guide-library" aria-label="Lessons"><h2>Lessons <span>{reports.length}</span></h2>{reports.map((r) => <button key={r.session} className={r.session === selected ? 'is-current' : ''} aria-pressed={r.session === selected} onClick={() => setSelected(r.session)}><strong>{when(r.t)}</strong><span>{r.steps.filter((s) => s.outcome === 'alone').length}/{r.steps.filter((s) => s.outcome !== 'not_reached').length} alone · {r.steps.filter((s) => s.outcome === 'caught').length} caught</span></button>)}</aside>
        <section className="guide-document">
          <div className="guide-document-heading"><div><p className="guide-eyebrow">Mastery report · {when(report.t)}</p><h2>{report.summary}</h2></div></div>
          <ol className="mastery-steps">{report.steps.map((s) => <li key={s.step_id}><span className={`dash-chip outcome-${s.outcome}`}>{OUTCOME[s.outcome]}</span><div><strong>{s.title}</strong><p className="dash-muted">{s.note}</p></div></li>)}</ol>
          {report.practise_next.length > 0 && <div className="wm-open"><h3>Practise next</h3><ul>{report.practise_next.map((p) => <li key={p}>{p}</li>)}</ul></div>}
        </section>
      </div>}
  </>
}
