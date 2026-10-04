import { useEffect, useState, type ReactNode } from 'react'
import { desktopBridge, type DashboardBridge, type Settings } from './bridge'
import { GuidesPage } from './GuidesPage'
import { WorkMapsPage } from './WorkMapsPage'
import { ProfilesPage } from './ProfilesPage'
import { MemoryPage } from './MemoryPage'
import { PrivacyPage } from './PrivacyPage'
import { LessonsPage } from './LessonsPage'
import './dashboard.css'

const TABS = [
  ['guides', 'Guides'],
  ['workmaps', 'Work Maps'],
  ['profiles', 'App Profiles'],
  ['memory', 'Memory'],
  ['privacy', 'Privacy'],
  ['lessons', 'Lessons'],
] as const
type Tab = (typeof TABS)[number][0]

/** #/dashboard/<tab>?query (the main process opens e.g. "profiles?key=…&q=…"). */
function parseHash(): { tab: Tab; params: URLSearchParams } {
  const rest = location.hash.replace(/^#\/?dashboard\/?/, '')
  const [name, query = ''] = rest.split('?')
  const tab = (TABS.find(([id]) => id === name)?.[0] ?? 'guides') as Tab
  return { tab, params: new URLSearchParams(query) }
}

/** First run (PLAN §5.1): the role and the expert's name, then a look at the privacy defaults. */
function Welcome({ bridge, settings, done }: { bridge: DashboardBridge; settings: Settings; done: (s: Settings) => void }) {
  const [role, setRole] = useState(settings.role)
  const [expert, setExpert] = useState(settings.expert)
  const [error, setError] = useState('')
  return <section className="dash-welcome" aria-label="Set up the apprentice">
    <div><p className="guide-eyebrow">Welcome</p><h2>Who is the apprentice learning from?</h2><p className="dash-muted">The role goes into every question the apprentice asks. Password managers, banking sites and private windows are never watched, and card numbers, IBANs and keys are masked before anything is stored. Review that on the Privacy tab.</p></div>
    <form className="dash-form" onSubmit={(e) => { e.preventDefault(); void bridge.invoke('settings:set', { role, expert, onboarded: true }).then(done).catch(() => setError('Could not save. Try again.')) }}>
      <label>Role<input value={role} maxLength={80} onChange={(e) => setRole(e.target.value)} placeholder="Accounts payable clerk" /></label>
      <label>Expert’s name<input value={expert} maxLength={60} onChange={(e) => setExpert(e.target.value)} placeholder="Sabine" /></label>
      <button className="guide-primary" disabled={!role.trim() || !expert.trim()}>Start</button>
      {error && <span className="guide-error">{error}</span>}
    </form>
  </section>
}

export default function Dashboard({ bridge = desktopBridge() }: { bridge?: DashboardBridge }) {
  const [route, setRoute] = useState(parseHash)
  const [settings, setSettings] = useState<Settings | null>(null)
  useEffect(() => {
    const onHash = () => setRoute(parseHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  useEffect(() => {
    if (!bridge) return
    void bridge.invoke('settings:get', {}).then(setSettings).catch(() => setSettings(null)) // the guide preview has no settings channel
  }, [bridge])
  function go(tab: Tab) {
    history.replaceState(null, '', `#/dashboard/${tab}`)
    setRoute({ tab, params: new URLSearchParams() })
  }
  let page: ReactNode
  switch (route.tab) {
    case 'workmaps': page = <WorkMapsPage bridge={bridge} />; break
    case 'profiles': page = <ProfilesPage bridge={bridge} params={route.params} />; break
    case 'memory': page = <MemoryPage bridge={bridge} />; break
    case 'privacy': page = <PrivacyPage bridge={bridge} />; break
    case 'lessons': page = <LessonsPage bridge={bridge} params={route.params} />; break
    default: page = <GuidesPage bridge={bridge} />
  }
  return <div className="apprentice-dashboard">
    <header className="guide-header"><div className="guide-wordmark">apprentice<span>Knowledge workspace</span></div><span className="guide-local">Stored on this computer</span></header>
    <nav className="dash-tabs" aria-label="Dashboard sections">{TABS.map(([id, label]) => <button key={id} className={route.tab === id ? 'is-current' : ''} aria-current={route.tab === id ? 'page' : undefined} onClick={() => go(id)}>{label}</button>)}</nav>
    <main>
      {bridge && settings && !settings.onboarded && <Welcome bridge={bridge} settings={settings} done={setSettings} />}
      {page}
    </main>
  </div>
}
