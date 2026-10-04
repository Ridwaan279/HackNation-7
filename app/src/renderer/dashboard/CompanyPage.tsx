// Company profile: who Protégé works for, what it has learned so far, and how it treats privacy.
// The detailed pages (Privacy, Memory, App profiles) sit next to it as tabs.
import { useEffect, useState } from 'react'
import { appLabel, errorText, type DashboardBridge, type PrivacyState, type Settings } from './bridge'

interface Knows { recordings: number; confirmed: number; guides: number; apps: number; minutes: number; profiles: number; lessons: number }

const MASK_LABELS: Record<string, string> = { passwords: 'passwords', secrets: 'API keys', cards: 'card numbers', iban: 'IBANs', ssn: 'SSNs', email: 'emails', phone: 'phone numbers' }

export function CompanyPage({ bridge, settings, saved, open }: {
  bridge: DashboardBridge
  settings: Settings
  saved: (s: Settings) => void
  open: (page: string) => void
}) {
  const [company, setCompany] = useState(settings.company)
  const [role, setRole] = useState(settings.role)
  const [teaching, setTeaching] = useState(settings.teaching)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [knows, setKnows] = useState<Knows | null>(null)
  const [privacy, setPrivacy] = useState<PrivacyState | null>(null)
  const [topApps, setTopApps] = useState<string[]>([])

  useEffect(() => {
    let canceled = false
    // Each source on its own: one missing service must not blank the page.
    void Promise.allSettled([
      bridge.invoke('workmaps:list', {}),
      bridge.invoke('guides:list', {}),
      bridge.invoke('memory:list', {}),
      bridge.invoke('profiles:list', {}),
      bridge.invoke('mastery:list', {}),
      bridge.invoke('privacy:get', {}),
    ]).then(([maps, guides, memory, profiles, lessons, priv]) => {
      if (canceled) return
      const ok = <T,>(r: PromiseSettledResult<T>) => (r.status === 'fulfilled' ? r.value : null)
      const m = ok(maps) ?? []
      const apps = ok(memory) ?? []
      setKnows({
        recordings: m.length,
        confirmed: m.filter((w) => w.status === 'confirmed').length,
        guides: (ok(guides) ?? []).length,
        apps: apps.length,
        minutes: apps.reduce((sum, a) => sum + a.minutes, 0),
        profiles: (ok(profiles) ?? []).length,
        lessons: (ok(lessons) ?? []).length,
      })
      setTopApps(apps.slice().sort((a, b) => b.minutes - a.minutes).slice(0, 5).map((a) => appLabel(a.key)))
      setPrivacy(ok(priv))
    })
    return () => { canceled = true }
  }, [bridge])

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setNotice(''); setError('')
    try {
      saved(await bridge.invoke('settings:set', { company, role, teaching, onboarded: true }))
      setNotice('Saved. New questions use this role.')
    } catch (failure) { setError(errorText(failure, 'Could not save. Try again.')) }
  }

  const masked = privacy ? Object.entries(privacy.privacy.mask).filter(([, on]) => on).map(([k]) => MASK_LABELS[k] ?? k) : []
  const skipped = privacy ? [privacy.privacy.skip.password_managers && 'password managers', privacy.privacy.skip.banking && 'banking sites', privacy.privacy.skip.private_windows && 'private windows'].filter(Boolean) as string[] : []
  const stat = (value: number | undefined, label: string, hint?: string) => <div className="company-stat"><strong>{value ?? '–'}</strong><span>{label}</span>{hint && <small>{hint}</small>}</div>

  return <>
    <div className="guide-page-heading"><div>
      <p className="guide-eyebrow">Company profile</p>
      <h1>{settings.company.trim() || 'Your company'}</h1>
      <p>Who Protégé is learning for, what it knows so far, and what it never looks at.</p>
    </div></div>
    {error && <div className="guide-error" role="alert">{error}</div>}
    {notice && <div className="guide-notice" role="status">{notice}</div>}
    <div className="privacy-grid">
      <section className="dash-card"><h3>Company and role</h3>
        <form className="dash-form" onSubmit={(e) => void save(e)}>
          <label>Company name<input value={company} maxLength={80} placeholder="Northwind" onChange={(e) => setCompany(e.target.value)} /></label>
          <label>Your role<input value={role} maxLength={80} placeholder="Head of customer support" onChange={(e) => setRole(e.target.value)} /></label>
          <label>What you are teaching<input value={teaching} maxLength={120} placeholder="How we handle a refund request" onChange={(e) => setTeaching(e.target.value)} /></label>
          <p className="dash-muted">The role goes into every question the ghost asks and every lesson it gives. Nobody is called by name.</p>
          <button className="guide-primary" disabled={!role.trim()}>Save</button>
        </form>
      </section>

      <section className="dash-card"><h3>What Protégé knows</h3>
        <div className="company-stats">
          {stat(knows?.recordings, 'Work Maps', knows ? `${knows.confirmed} confirmed by the expert` : undefined)}
          {stat(knows?.guides, 'Step guides')}
          {stat(knows?.profiles, 'App Profiles')}
          {stat(knows?.lessons, 'Lessons given')}
          {stat(knows?.apps, 'Apps learned', knows ? `${knows.minutes} active minutes` : undefined)}
        </div>
        {topApps.length > 0 && <p className="dash-muted">Most used: {topApps.join(', ')}.</p>}
        <div className="dash-actions"><button onClick={() => open('profiles')}>App profiles</button><button onClick={() => open('memory')}>Memory</button></div>
      </section>

      <section className="dash-card"><h3>Privacy at a glance</h3>
        {privacy ? <ul className="company-list">
          <li><strong>Watching:</strong> {privacy.paused_until ? `paused until ${new Date(privacy.paused_until).toLocaleString()}` : 'on. Ctrl+Shift+O goes off the record.'}</li>
          <li><strong>Never watched:</strong> {skipped.length ? skipped.join(', ') : 'nothing skipped by default'}{privacy.privacy.blocked_apps.length + privacy.privacy.blocked_domains.length ? `, plus ${privacy.privacy.blocked_apps.length + privacy.privacy.blocked_domains.length} blocked apps and sites` : ''}.</li>
          <li><strong>Masked before storing:</strong> {masked.length ? masked.join(', ') : 'nothing'}. Password fields are never read.</li>
          <li><strong>Raw logs kept for:</strong> {privacy.privacy.raw_retention_days} days.{privacy.privacy.allow_only ? ' Only allowed apps are watched.' : ''}</li>
        </ul> : <p className="dash-muted">Loading…</p>}
        <div className="dash-actions"><button className="guide-primary" onClick={() => open('privacy')}>Privacy settings</button></div>
      </section>

      <section className="dash-card"><h3>How onboarding works here</h3>
        <ol className="company-list numbered">
          <li><strong>The expert records</strong> a task once, explaining it as they go. The ghost listens first and asks why at the pauses.</li>
          <li><strong>A Work Map is drafted</strong> on Stop. The expert answers a few questions and confirms it.</li>
          <li><strong>Always on:</strong> Protégé keeps learning each app as masked text, so it knows the exceptions too.</li>
          <li><strong>The new hire learns</strong> on their own screen. The ghost points at the right field and stops a mistake before it is saved.</li>
        </ol>
      </section>
    </div>
  </>
}
