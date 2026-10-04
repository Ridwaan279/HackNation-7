import { useEffect, useState, type ReactNode } from 'react'
import { ArrowLeftIcon, BuildingsIcon } from '@phosphor-icons/react'
import { ModeSwitch } from '../lib/ModeSwitch'
import { desktopBridge, type DashboardBridge, type Mode, type SessionInfo, type Settings } from './bridge'
import { RecordPage } from './RecordPage'
import { LearnPage } from './LearnPage'
import { GuidesPage } from './GuidesPage'
import { WorkMapsPage } from './WorkMapsPage'
import { ProfilesPage } from './ProfilesPage'
import { MemoryPage } from './MemoryPage'
import { PrivacyPage } from './PrivacyPage'
import { LessonsPage } from './LessonsPage'
import { CompanyPage } from './CompanyPage'
import './dashboard.css'
import './shell.css'
import '../protege.css'

/** Two tabs per mode; the details live on the Company profile (a labelled button in the header). */
const TABS: Record<Mode, { id: string; label: string }[]> = {
  expert: [{ id: 'record', label: 'Record' }, { id: 'recordings', label: 'Recordings' }],
  newhire: [{ id: 'learn', label: 'Learn' }, { id: 'progress', label: 'Progress' }],
}
const PROFILE = [
  { id: 'company', label: 'Company' },
  { id: 'privacy', label: 'Privacy' },
  { id: 'memory', label: 'Memory' },
  { id: 'profiles', label: 'App profiles' },
]
/** Older links (the main process opens e.g. "lessons?session=…" or "profiles?key=…"). */
const LEGACY: Record<string, string> = { guides: 'recordings', workmaps: 'recordings', lessons: 'progress', you: 'company', settings: 'company' }

const IDLE: SessionInfo = { id: null, kind: null, phase: 'idle', started_at: null, offRecord: false }

/** #/dashboard/<page>?query */
function parseHash(): { page: string; params: URLSearchParams } {
  const rest = location.hash.replace(/^#\/?dashboard\/?/, '')
  const [name = '', query = ''] = rest.split('?')
  return { page: LEGACY[name] ?? name, params: new URLSearchParams(query) }
}

/** First run: who Protégé is learning from and what for. Nothing is pre-filled; every team describes its own work. */
function Welcome({ bridge, settings, done }: { bridge: DashboardBridge; settings: Settings; done: (s: Settings) => void }) {
  const [company, setCompany] = useState(settings.company)
  const [role, setRole] = useState(settings.role)
  const [teaching, setTeaching] = useState(settings.teaching)
  const [error, setError] = useState('')
  const ready = role.trim() && teaching.trim()
  return <section className="welcome" aria-label="Set up Protégé">
    <span className="welcome-eyebrow">Welcome</span>
    <h2>Tell Protégé about you</h2>
    <p>So its questions, Work Maps and lessons fit your work. Password managers, banking sites and private windows are never watched. You can change this later on the Company profile.</p>
    <form onSubmit={(e) => { e.preventDefault(); void bridge.invoke('settings:set', { company, role, teaching, onboarded: true }).then(done).catch(() => setError('Could not save. Try again.')) }}>
      <label>Company<input value={company} maxLength={80} onChange={(e) => setCompany(e.target.value)} placeholder="Northwind" /></label>
      <label>Your role<input value={role} maxLength={80} onChange={(e) => setRole(e.target.value)} placeholder="Head of customer support" required /></label>
      <label>What are you teaching?<input value={teaching} maxLength={120} onChange={(e) => setTeaching(e.target.value)} placeholder="How we handle a refund request" required /></label>
      <button className="primary" disabled={!ready}>Save and start</button>
    </form>
    {error && <p className="home-error" role="alert">{error}</p>}
  </section>
}

export default function Dashboard({ bridge = desktopBridge() }: { bridge?: DashboardBridge }) {
  const [route, setRoute] = useState(parseHash)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [session, setSession] = useState<SessionInfo>(IDLE)
  const [recordingsView, setRecordingsView] = useState<'workmaps' | 'guides'>(() => (location.hash.includes('/guides') ? 'guides' : 'workmaps'))

  useEffect(() => {
    const onHash = () => setRoute(parseHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  useEffect(() => {
    if (!bridge) return
    void bridge.invoke('settings:get', {}).then(setSettings).catch(() => setSettings(null))
    void bridge.invoke('session:state', {}).then(setSession).catch(() => undefined)
    const offSettings = bridge.on('settings:updated', (s) => setSettings(s as Settings))
    const offSession = bridge.on('session:state', (s) => setSession(s as SessionInfo))
    return () => { offSettings(); offSession() }
  }, [bridge])

  const mode: Mode = settings?.mode ?? 'expert'
  const inSettings = PROFILE.some((s) => s.id === route.page)
  const page = inSettings || TABS[mode].some((t) => t.id === route.page) ? route.page : TABS[mode][0].id

  function go(next: string) {
    history.replaceState(null, '', `#/dashboard/${next}`)
    setRoute({ page: next, params: new URLSearchParams() })
  }
  function switchMode(next: Mode) {
    if (!bridge) return
    void bridge.invoke('settings:set', { mode: next }).then((s) => { setSettings(s); go(TABS[next][0].id) })
  }

  if (!bridge) return <div className="shell"><main><section className="home"><h1>Open this in Protégé</h1></section></main></div>

  let content: ReactNode
  switch (page) {
    case 'record': content = <RecordPage bridge={bridge} session={session} openRecordings={() => go('recordings')} />; break
    case 'recordings': content = <>
      <div className="subswitch" role="tablist" aria-label="Recordings">
        <button role="tab" aria-selected={recordingsView === 'workmaps'} onClick={() => setRecordingsView('workmaps')}>Work Maps</button>
        <button role="tab" aria-selected={recordingsView === 'guides'} onClick={() => setRecordingsView('guides')}>Step guides</button>
      </div>
      {recordingsView === 'workmaps' ? <WorkMapsPage bridge={bridge} /> : <GuidesPage bridge={bridge} />}
    </>; break
    case 'learn': content = <LearnPage bridge={bridge} session={session} openProgress={() => go('progress')} />; break
    case 'progress': content = <LessonsPage bridge={bridge} params={route.params} />; break
    case 'privacy': content = <PrivacyPage bridge={bridge} />; break
    case 'memory': content = <MemoryPage bridge={bridge} />; break
    case 'profiles': content = <ProfilesPage bridge={bridge} params={route.params} />; break
    case 'company': content = settings ? <CompanyPage bridge={bridge} settings={settings} saved={setSettings} open={go} /> : null; break
  }

  const busy = session.phase !== 'idle'
  return <div className="shell">
    <header className="shell-bar">
      <span className="shell-name">Protégé</span>
      {inSettings
        ? <span className="shell-title">Company profile</span>
        : <ModeSwitch mode={mode} onChange={switchMode} disabled={busy} />}
      {inSettings
        ? <button className="icon-button" onClick={() => go(TABS[mode][0].id)}><ArrowLeftIcon size={18} /> Done</button>
        : <button className="icon-button profile-button" title="Company, privacy, memory and app profiles" onClick={() => go('company')}><BuildingsIcon size={18} /> {settings?.company.trim() || 'Company profile'}</button>}
    </header>
    <nav className="shell-tabs" aria-label={inSettings ? 'Settings' : 'Sections'}>
      {(inSettings ? PROFILE : TABS[mode]).map((t) => (
        <button key={t.id} aria-current={page === t.id ? 'page' : undefined} onClick={() => go(t.id)}>{t.label}</button>
      ))}
    </nav>
    <main className={`shell-main page-${page}`}>
      {settings && !settings.onboarded && !inSettings && <Welcome bridge={bridge} settings={settings} done={setSettings} />}
      {content}
    </main>
  </div>
}
