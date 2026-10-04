import { useCallback, useEffect, useState } from 'react'
import type { AppProfile, MemoryApp } from '@shared/contracts'
import { appLabel, errorText, when, type DashboardBridge } from './bridge'

function List({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null
  return <div className="profile-section"><h4>{title}</h4><ul>{items.map((item) => <li key={item}>{item}</li>)}</ul></div>
}

export function ProfilesPage({ bridge, params }: { bridge?: DashboardBridge; params: URLSearchParams }) {
  const [profiles, setProfiles] = useState<AppProfile[]>([])
  const [apps, setApps] = useState<MemoryApp[]>([])
  const [selected, setSelected] = useState(params.get('key') ?? '')
  const [asking, setAsking] = useState<string>(params.get('q') ?? '')
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const reload = useCallback(async () => {
    if (!bridge) { setLoading(false); return }
    try {
      const [p, a] = await Promise.all([bridge.invoke('profiles:list', {}), bridge.invoke('memory:list', {})])
      setProfiles(p); setApps(a); setError('')
      setSelected((current) => current && (p.some((x) => x.key === current) || a.some((x) => x.key === current)) ? current : p[0]?.key ?? '')
    } catch (failure) { setError(errorText(failure, 'Unable to load App Profiles.')) }
    finally { setLoading(false) }
  }, [bridge])
  useEffect(() => {
    void reload()
    if (!bridge) return
    return bridge.on('profile:updated', (payload) => {
      const p = payload as AppProfile
      setProfiles((previous) => [p, ...previous.filter((x) => x.key !== p.key)])
    })
  }, [bridge, reload])
  useEffect(() => { if (params.get('key')) setSelected(params.get('key')!); if (params.get('q')) setAsking(params.get('q')!) }, [params])
  const profile = profiles.find((p) => p.key === selected)
  const unprofiled = apps.filter((a) => !profiles.some((p) => p.key === a.key))
  async function refresh(key: string) {
    if (!bridge) return
    setBusy(key); setError('')
    try { const p = await bridge.invoke('profile:refresh', { key }); if (p) { setProfiles((previous) => [p, ...previous.filter((x) => x.key !== p.key)]); setSelected(p.key) } }
    catch (failure) { setError(errorText(failure)) }
    finally { setBusy('') }
  }
  async function submit() {
    if (!bridge || !profile || !asking || !answer.trim()) return
    setBusy('answer'); setError('')
    try { const p = await bridge.invoke('profile:answer', { key: profile.key, question: asking, answer }); setProfiles((previous) => [p, ...previous.filter((x) => x.key !== p.key)]); setAsking(''); setAnswer('') }
    catch (failure) { setError(errorText(failure)) }
    finally { setBusy('') }
  }
  return <>
    <div className="guide-page-heading"><div><p className="guide-eyebrow">Always on / App Profiles</p><h1>What it learned about each app.</h1><p>Built from masked text only. Screenshots are described, then deleted.</p></div><button onClick={() => void reload()}>Reload</button></div>
    {error && <div className="guide-error" role="alert">{error}</div>}
    {!bridge ? <div className="guide-empty"><h2>Open this workspace in Apprentice</h2></div> : loading ? <div className="guide-empty" role="status">Loading…</div> : !profiles.length && !unprofiled.length ? <div className="guide-empty"><h2>Nothing learned yet.</h2><p>Use your apps as usual. A profile appears after about 10 minutes of activity in an app.</p></div> :
      <div className="guide-workspace">
        <aside className="guide-library" aria-label="Apps"><h2>Apps <span>{profiles.length}</span></h2>
          {profiles.map((p) => <button key={p.key} className={p.key === selected ? 'is-current' : ''} aria-pressed={p.key === selected} onClick={() => setSelected(p.key)}><strong>{p.name || appLabel(p.key)}</strong><span>{p.minutes} min · {when(p.last_seen)}</span></button>)}
          {unprofiled.length > 0 && <><h2 className="dash-subhead">Not summarized yet</h2>{unprofiled.map((a) => <button key={a.key} disabled={busy === a.key} onClick={() => void refresh(a.key)}><strong>{appLabel(a.key)}</strong><span>{busy === a.key ? 'Summarizing…' : 'Build profile'}</span></button>)}</>}
        </aside>
        <section className="guide-document">{profile ? <>
          <div className="guide-document-heading"><div><p className="guide-eyebrow">{profile.key}</p><h2>{profile.name || appLabel(profile.key)}</h2><p className="dash-muted">{profile.purpose || 'Purpose not known yet.'}</p></div><div className="dash-actions"><span className="dash-muted">{profile.minutes} active minutes</span><button disabled={busy === profile.key} onClick={() => void refresh(profile.key)}>{busy === profile.key ? 'Refreshing…' : 'Refresh'}</button></div></div>
          <div className="profile-grid">
            {profile.recurring_tasks.length > 0 && <div className="profile-section"><h4>Recurring tasks</h4><ul>{profile.recurring_tasks.map((t) => <li key={t.name}>{t.name} <span className="dash-muted">×{t.evidence}</span></li>)}</ul></div>}
            <List title="Today" items={profile.today} />
            <List title="Screens and fields" items={profile.screens_fields} />
            <List title="Patterns" items={profile.patterns} />
            <List title="Exceptions seen" items={profile.exceptions} />
            {(profile.guides.length > 0 || profile.workmaps.length > 0) && <div className="profile-section"><h4>Linked</h4><p>{profile.guides.length} guide(s), {profile.workmaps.length} Work Map(s)</p></div>}
          </div>
          <div className="profile-questions"><h3>The apprentice is curious</h3>
            {profile.open_questions.length ? <ul>{profile.open_questions.map((q) => <li key={q}><span>{q}</span>{asking !== q && <button className="guide-text-button" onClick={() => { setAsking(q); setAnswer('') }}>Answer</button>}</li>)}</ul> : <p className="dash-muted">No open questions right now.</p>}
            {asking && <form className="profile-answer" onSubmit={(e) => { e.preventDefault(); void submit() }}><label>{asking}<textarea autoFocus rows={3} maxLength={2000} value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Answer in your own words. Card numbers, IBANs and keys are masked before saving." /></label><div className="dash-actions"><button className="guide-primary" disabled={!answer.trim() || busy === 'answer'}>Save answer</button><button type="button" onClick={() => setAsking('')}>Cancel</button></div></form>}
          </div>
          {profile.expert_quotes.length > 0 && <div className="profile-questions"><h3>What the expert said</h3>{profile.expert_quotes.slice().reverse().map((q, i) => <blockquote key={i}><p>“{q.a}”</p><cite>{q.q} · {when(q.t)}</cite></blockquote>)}</div>}
        </> : <div className="guide-empty"><h3>Choose an app</h3></div>}</section>
      </div>}
  </>
}
