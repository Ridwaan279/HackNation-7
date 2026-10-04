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

/** First run (PLAN §5.1): the role the apprentice is learning. Nobody is asked for or called by a name. */
function Welcome({ bridge, settings, done }: { bridge: DashboardBridge; settings: Settings; done: (s: Settings) => void }) {
  const [role, setRole] = useState(settings.role)
  const [company, setCompany] = useState(settings.company)
  const [error, setError] = useState('')
  return <section className="welcome" aria-label="Set up the apprentice">
    <h2>Set up the apprentice</h2>
    <p>The role goes into every question it asks. Password managers, banking sites and private windows are never watched. You can change this later on the Company profile.</p>
    <form onSubmit={(e) => { e.preventDefault(); void bridge.invoke('settings:set', { role, company, onboarded: true }).then(done).catch(() => setError('Could not save. Try again.')) }}>
      <label>Company<input value={company} maxLength={80} onChange={(e) => setCompany(e.target.value)} placeholder="Acme GmbH" /></label>
      <label>Role<input value={role} maxLength={80} onChange={(e) => setRole(e.target.value)} placeholder="Accounts payable clerk" /></label>
      <button className="primary" disabled={!role.trim()}>Save</button>
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

  if (!bridge) return <div className="shell"><main><section className="home"><h1>Open this in Apprentice</h1></section></main></div>

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
      <span className="shell-name">Apprentice</span>
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
