import { useCallback, useEffect, useState } from 'react'
import type { MemoryApp, MemoryEntry } from '@shared/contracts'
import { appLabel, errorText, when, type DashboardBridge } from './bridge'

const size = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
const time = (t: number) => new Date(t * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })

function describe(entry: MemoryEntry): [string, string] {
  switch (entry.type) {
    case 'context': return ['Window', entry.title]
    case 'text': return ['Text', entry.lines.join(' · ')]
    case 'commit': return ['Entered', `${entry.field}: ${entry.old || '(empty)'} → ${entry.new || '(empty)'}${entry.masked ? ' (masked)' : ''}`]
    case 'click': return ['Clicked', `${entry.target} (${entry.control_type})`]
    case 'description': return ['Screen', entry.text]
    case 'highlight': return ['Highlighted', entry.text]
  }
}

export function MemoryPage({ bridge }: { bridge?: DashboardBridge }) {
  const [apps, setApps] = useState<MemoryApp[]>([])
  const [key, setKey] = useState('')
  const [day, setDay] = useState('')
  const [entries, setEntries] = useState<MemoryEntry[]>([])
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(true)
  const reload = useCallback(async () => {
    if (!bridge) { setLoading(false); return }
    try {
      const list = await bridge.invoke('memory:list', {})
      setApps(list); setError('')
      setKey((current) => list.some((a) => a.key === current) ? current : list[0]?.key ?? '')
    } catch (failure) { setError(errorText(failure, 'Unable to load memory.')) }
    finally { setLoading(false) }
  }, [bridge])
  useEffect(() => { void reload() }, [reload])
  const app = apps.find((a) => a.key === key)
  useEffect(() => { setDay((current) => app?.days.includes(current) ? current : app?.days[0] ?? '') }, [app?.key, app?.days.join()])
  useEffect(() => {
    let canceled = false
    setEntries([])
    if (bridge && key && day) void bridge.invoke('memory:day', { key, day }).then((list) => { if (!canceled) setEntries(list.slice().reverse()) }).catch((failure) => { if (!canceled) setError(errorText(failure)) })
    return () => { canceled = true }
  }, [bridge, key, day])
  async function remove(target: { key?: string; day?: string }, question: string) {
    if (!bridge || !window.confirm(question)) return
    try { setApps(await bridge.invoke('memory:delete', target)); setNotice('Deleted.'); if (!target.day) setKey('') ; if (target.day) setDay('') }
    catch (failure) { setError(errorText(failure)) }
  }
  return <>
    <div className="guide-page-heading"><div><p className="guide-eyebrow">Always on / Memory</p><h1>Everything it kept, and a way to delete it.</h1><p>Masked text per app and day. Raw logs are deleted after the retention period; App Profiles stay until you delete them.</p></div><div className="dash-actions"><button onClick={() => void reload()}>Reload</button><button className="guide-danger" disabled={!apps.length} onClick={() => void remove({}, 'Delete all ambient memory and every App Profile?')}>Delete all memory</button></div></div>
    {error && <div className="guide-error" role="alert">{error}</div>}
    {notice && <div className="guide-notice" role="status">{notice}</div>}
    {!bridge ? <div className="guide-empty"><h2>Open this workspace in Protégé</h2></div> : loading ? <div className="guide-empty" role="status">Loading…</div> : !apps.length ? <div className="guide-empty"><h2>Memory is empty.</h2><p>Nothing has been kept. Skipped and blocked apps, paused time and lessons are never stored.</p></div> :
      <div className="guide-workspace">
        <aside className="guide-library" aria-label="Apps in memory"><h2>Apps <span>{apps.length}</span></h2>{apps.map((a) => <button key={a.key} className={a.key === key ? 'is-current' : ''} aria-pressed={a.key === key} onClick={() => setKey(a.key)}><strong>{appLabel(a.key)}</strong><span>{a.minutes} min · {size(a.bytes)} · {when(a.last_seen)}</span></button>)}</aside>
        <section className="guide-document">{app ? <>
          <div className="guide-document-heading"><div><p className="guide-eyebrow">{app.key}</p><h2>{appLabel(app.key)}</h2><p className="dash-muted">{app.minutes} active minutes · {size(app.bytes)} · last seen {when(app.last_seen)}</p></div><button className="guide-danger" onClick={() => void remove({ key: app.key }, `Delete everything kept about ${appLabel(app.key)}, including its App Profile?`)}>Delete this app</button></div>
          <div className="memory-days">{app.days.map((d) => <button key={d} className={d === day ? 'is-current' : ''} aria-pressed={d === day} onClick={() => setDay(d)}>{d}</button>)}{day && <button className="guide-danger" onClick={() => void remove({ key: app.key, day }, `Delete ${appLabel(app.key)} on ${day}?`)}>Delete this day</button>}</div>
          <div className="memory-log" role="table" aria-label={`Memory for ${day}`}>{entries.length ? entries.map((entry, i) => { const [kind, text] = describe(entry); return <div key={i} role="row" className={`memory-row memory-${entry.type}`}><span role="cell" className="memory-time">{time(entry.t)}</span><span role="cell" className="memory-kind">{kind}</span><span role="cell">{text}</span></div> }) : <p className="dash-muted">No entries for this day.</p>}</div>
        </> : <div className="guide-empty"><h3>Choose an app</h3></div>}</section>
      </div>}
  </>
}
