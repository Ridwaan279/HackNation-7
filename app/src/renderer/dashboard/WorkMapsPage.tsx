import { useCallback, useEffect, useState } from 'react'
import type { Guide, WorkMap, WorkMapStep } from '@shared/contracts'
import { errorText, type DashboardBridge } from './bridge'

const RAIL: Record<string, string> = { limit: 'Limit', exception: 'Exception', stop_and_ask: 'Stop and ask' }
const sessionDate = (id: string) => {
  const m = id.match(/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})/)
  return m ? `${m[1]} ${m[2]}:${m[3]}` : ''
}
const clock = (t: number, start: number) => {
  const s = Math.max(0, Math.round(t - start))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function StepCard({ step, guide, start, bridge }: { step: WorkMapStep; guide: Guide | null; start: number; bridge: DashboardBridge }) {
  const [image, setImage] = useState<string | null>(null)
  const guideSteps = step.guide_steps.map((id) => guide?.steps.find((s) => s.id === id)).filter((s) => !!s)
  const shotStep = guideSteps.find((s) => s.shot && !s.screenshot_hidden)
  useEffect(() => {
    let canceled = false
    setImage(null)
    if (guide && shotStep) void bridge.invoke('guide:image', { id: guide.id, step_id: shotStep.id }).then((r) => { if (!canceled) setImage(r?.data_url ?? null) }).catch(() => undefined)
    return () => { canceled = true }
  }, [bridge, guide?.id, shotStep?.id])
  return <article className="wm-step">
    <div className="wm-step-index">{step.index}</div>
    <div className="wm-step-body">
      <div className="wm-step-head"><h3>{step.title}</h3>{step.judgment_call && <span className="dash-chip">Judgment call</span>}{step.t_start > 0 && <span className="wm-time">{clock(step.t_start, start)}</span>}</div>
      {step.decision && <p className="wm-decision"><strong>Decision</strong> {step.decision}</p>}
      {step.reason.text ? <blockquote><p>“{step.reason.text}”</p><cite>{step.reason.source === 'debrief' ? 'Debrief' : 'Said while working'}{step.reason.t ? ` · ${clock(step.reason.t, start)}` : ''}</cite></blockquote> : <p className="dash-muted">No reason recorded yet.</p>}
      {step.guardrails.length > 0 && <ul className="wm-rails">{step.guardrails.map((g) => <li key={g.id}><span className={`dash-chip rail-${g.type}`}>{RAIL[g.type] ?? g.type}</span><span><strong>{g.rule}</strong><em>“{g.quote}”</em></span></li>)}</ul>}
      {guideSteps.length > 0 && <p className="wm-guide-steps">Guide steps: {guideSteps.map((s) => `${s.n}. ${s.title}`).join(' · ')}</p>}
    </div>
    <div className="wm-shot">{image ? <img src={image} alt={`Screen for ${step.title}`} /> : shotStep ? <span className="dash-muted">Loading screenshot…</span> : <span className="dash-muted">No screenshot</span>}</div>
  </article>
}

export function WorkMapsPage({ bridge }: { bridge?: DashboardBridge }) {
  const [maps, setMaps] = useState<WorkMap[]>([])
  const [guides, setGuides] = useState<Guide[]>([])
  const [selected, setSelected] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(true)
  const reload = useCallback(async () => {
    if (!bridge) { setLoading(false); return }
    try {
      const [m, g] = await Promise.all([bridge.invoke('workmaps:list', {}), bridge.invoke('guides:list', {})])
      setMaps(m); setGuides(g); setError('')
      setSelected((current) => m.some((x) => x.id === current) ? current : m[0]?.id ?? '')
    } catch (failure) { setError(errorText(failure, 'Unable to load Work Maps.')) }
    finally { setLoading(false) }
  }, [bridge])
  useEffect(() => {
    void reload()
    if (!bridge) return
    const off = bridge.on('workmap:updated', (payload) => {
      const map = payload as WorkMap
      setMaps((previous) => [map, ...previous.filter((m) => m.id !== map.id)].sort((a, b) => b.id.localeCompare(a.id)))
      setSelected((current) => current || map.id)
    })
    const offGuide = bridge.on('guide:updated', (payload) => { const g = payload as Guide; setGuides((previous) => [g, ...previous.filter((x) => x.id !== g.id)]) })
    return () => { off(); offGuide() }
  }, [bridge, reload])
  const map = maps.find((m) => m.id === selected)
  const guide = map ? guides.find((g) => g.id === map.guide) ?? null : null
  const title = (m: WorkMap) => guides.find((g) => g.id === m.guide)?.title.replace(/ guide$/, '') || m.role
  const start = guide?.steps[0]?.t ?? map?.steps[0]?.t_start ?? 0
  async function lesson() {
    if (!bridge || !map) return
    try { await bridge.invoke('session:start', { kind: 'tutor', workmap_id: map.id }); setNotice('Lesson started. The tutor is on the ghost.') }
    catch (failure) { setError(errorText(failure)) }
  }
  return <>
    <div className="guide-page-heading"><div><p className="guide-eyebrow">Map / Work Maps</p><h1>The why behind the work.</h1><p>Each step links to the screen it happened on and to the expert’s own words.</p></div><button onClick={() => void reload()}>Reload</button></div>
    {error && <div className="guide-error" role="alert">{error}</div>}
    {notice && <div className="guide-notice" role="status">{notice}</div>}
    {!bridge ? <div className="guide-empty"><h2>Open this workspace in Apprentice</h2></div> : loading ? <div className="guide-empty" role="status">Loading…</div> : !map ? <div className="guide-empty"><h2>No Work Maps yet.</h2><p>Teach a task, press Stop, and answer the debrief. The draft appears here and is confirmed after the teach-back.</p></div> :
      <div className="guide-workspace">
        <aside className="guide-library" aria-label="Work Maps"><h2>Work Maps <span>{maps.length}</span></h2>{maps.map((m) => <button key={m.id} className={m.id === selected ? 'is-current' : ''} aria-pressed={m.id === selected} onClick={() => setSelected(m.id)}><strong>{title(m)}</strong><span>{m.status === 'confirmed' ? 'Confirmed' : 'Draft'} · {m.steps.length} steps{sessionDate(m.id) ? ` · ${sessionDate(m.id)}` : ''}</span></button>)}</aside>
        <section className="guide-document">
          <div className="guide-document-heading"><div><p className="guide-eyebrow">{map.role}</p><h2>{title(map)}</h2><p className="dash-muted">{map.status === 'confirmed' ? `Teach-back confirmed${map.teachback.t ? ` ${new Date(map.teachback.t * 1000).toLocaleString()}` : ''}` : 'Draft: the debrief is still filling the gaps.'}{map.teachback.corrections.length ? ` · ${map.teachback.corrections.length} correction(s)` : ''}</p></div><div className="dash-actions"><span className={`dash-chip status-${map.status}`}>{map.status === 'confirmed' ? 'Confirmed' : 'Draft'}</span><button className="guide-primary" onClick={() => void lesson()}>Start a lesson</button></div></div>
          {map.open_questions.length > 0 && <div className="wm-open"><h3>Open questions for the debrief</h3><ul>{map.open_questions.map((q) => <li key={q}>{q}</li>)}</ul></div>}
          {map.teachback.corrections.length > 0 && <div className="wm-open"><h3>Corrections from the expert</h3><ul>{map.teachback.corrections.map((c, i) => <li key={i}>Step {c.step_id}: “{c.quote}”</li>)}</ul></div>}
          <div className="wm-timeline">{map.steps.map((step) => <StepCard key={step.id} step={step} guide={guide} start={start} bridge={bridge} />)}</div>
        </section>
      </div>}
  </>
}
