import { useEffect, useState, type ReactNode } from 'react'
import { BookOpenTextIcon, BrainIcon, BuildingsIcon, ChatCircleDotsIcon, ChartLineUpIcon, CircleNotchIcon, DatabaseIcon, GraduationCapIcon, RecordIcon, ShieldCheckIcon, XIcon } from '@phosphor-icons/react'
import type { Icon } from '@phosphor-icons/react'
import type { GuideStep } from '@shared/contracts'
import type { ReplayCommand } from '../../common/ipc'
import { ModeSwitch } from '../lib/ModeSwitch'
import { shotUrl } from '../lib/api'
import { Ghost } from '../mascot/Ghost'
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
import { AskPage } from './AskPage'
import './dashboard.css'
import './shell.css'
import '../protege.css'
import './desktop.css'

/** Two tabs per mode; the details live on the Company profile (a labelled button in the header). */
const TABS: Record<Mode, { id: string; label: string; icon: Icon }[]> = {
  expert: [{ id: 'record', label: 'Record a task', icon: RecordIcon }, { id: 'recordings', label: 'Recordings', icon: BookOpenTextIcon }],
  newhire: [{ id: 'learn', label: 'Learn a task', icon: GraduationCapIcon }, { id: 'progress', label: 'Progress', icon: ChartLineUpIcon }],
}
const PROFILE = [
  { id: 'company', label: 'Company profile', icon: BuildingsIcon },
  { id: 'profiles', label: 'App profiles', icon: BrainIcon },
  { id: 'memory', label: 'Memory', icon: DatabaseIcon },
  { id: 'privacy', label: 'Privacy', icon: ShieldCheckIcon },
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
  const ready = company.trim() && role.trim()
  return <div className="onboarding"><div className="onboarding-brand">Protégé <span>for desktop</span></div>
    <div className="onboarding-content"><div className="onboarding-story"><span className="workspace-kicker">YOUR APPRENTICE STARTS HERE</span>
      <h1>Knowledge that stays with your team.</h1>
      <p>Tell Protégé where you work and what you do. It uses this context to ask better questions and make training relevant to your role.</p>
      <div className="onboarding-ghost" aria-hidden><Ghost state="idle" size={270} /></div>
      <span className="onboarding-privacy"><ShieldCheckIcon size={18} /> Password fields and private apps stay off limits.</span>
    </div>
    <form className="onboarding-form" onSubmit={(e) => { e.preventDefault(); void bridge.invoke('settings:set', { company: company.trim(), role: role.trim(), teaching: teaching.trim(), onboarded: true }).then(done).catch(() => setError('Could not save. Try again.')) }}>
      <span className="workspace-kicker">STEP 01 / 01</span><h2>Set up your workspace</h2><p>You can change these details from Company profile later.</p>
      <label>Company name<input value={company} maxLength={80} onChange={(e) => setCompany(e.target.value)} placeholder="e.g. Northwind" required autoFocus /></label>
      <label>Your role<input value={role} maxLength={80} onChange={(e) => setRole(e.target.value)} placeholder="e.g. Operations manager" required /></label>
      <label>What does your team do? <small>Optional</small><input value={teaching} maxLength={120} onChange={(e) => setTeaching(e.target.value)} placeholder="e.g. Approve supplier invoices" /></label>
      <button className="primary" disabled={!ready}>Continue to workspace</button>
      {error && <p className="home-error" role="alert">{error}</p>}
    </form></div>
  </div>
}

export default function Dashboard({ bridge = desktopBridge() }: { bridge?: DashboardBridge }) {
  const [route, setRoute] = useState(parseHash)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [session, setSession] = useState<SessionInfo>(IDLE)
  const [recordingsView, setRecordingsView] = useState<'workmaps' | 'guides'>(() => (location.hash.includes('/guides') ? 'guides' : 'workmaps'))
  const [replay, setReplay] = useState<ReplayCommand | null>(null)

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
    const offReplay = bridge.on('panel:replay', (cmd) => setReplay(cmd as ReplayCommand))
    const offNavigate = bridge.on('dashboard:navigate', (path) => {
      const next = String(path)
      history.replaceState(null, '', `#/dashboard/${next}`)
      setRoute(parseHash())
    })
    return () => { offSettings(); offSession(); offReplay(); offNavigate() }
  }, [bridge])

  const mode: Mode = settings?.mode ?? 'expert'
  const inSettings = PROFILE.some((s) => s.id === route.page)
  const page = route.page === 'ask' || inSettings || TABS[mode].some((t) => t.id === route.page) ? route.page : TABS[mode][0].id

  function go(next: string) {
    history.replaceState(null, '', `#/dashboard/${next}`)
    setRoute({ page: next, params: new URLSearchParams() })
  }
  function switchMode(next: Mode) {
    if (!bridge) return
    void bridge.invoke('settings:set', { mode: next }).then((s) => { setSettings(s); go(TABS[next][0].id) })
  }

  if (!bridge) return <div className="shell"><main><section className="home"><h1>Open this in Protégé</h1></section></main></div>
  if (!settings) return <div className="onboarding-loading"><CircleNotchIcon size={28} className="spin" /> Loading Protégé…</div>
  if (!settings.onboarded || !settings.company.trim() || !settings.role.trim()) return <Welcome bridge={bridge} settings={settings} done={setSettings} />

  let content: ReactNode
  switch (page) {
    case 'record': content = <RecordPage bridge={bridge} session={session} openRecordings={() => go('recordings')} requestNew={route.params.get('new') === '1'} />; break
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
    case 'company': content = <CompanyPage bridge={bridge} settings={settings} saved={setSettings} open={go} />; break
    case 'ask': content = null; break
  }

  const busy = session.phase !== 'idle'
  const title = [...TABS[mode], ...PROFILE, { id: 'ask', label: 'Ask Protégé' }].find((item) => item.id === page)?.label ?? 'Workspace'
  const navItem = (item: { id: string; label: string; icon: Icon }) => <button key={item.id} className="sidebar-link" aria-current={page === item.id ? 'page' : undefined} onClick={() => go(item.id)}><item.icon size={19} weight={page === item.id ? 'fill' : 'regular'} />{item.label}</button>
  return <div className="shell desktop-shell">
    <aside className="desktop-sidebar">
      <div className="desktop-brand"><div className="brand-mark" aria-hidden><Ghost state="idle" size={52} /></div><span>Protégé<small>WORKSPACE</small></span></div>
      <div className="sidebar-mode"><span className="sidebar-heading">YOUR MODE</span><ModeSwitch mode={mode} size="compact" onChange={switchMode} disabled={busy} /></div>
      <nav aria-label="Main navigation"><span className="sidebar-heading">WORKSPACE</span>{TABS[mode].map(navItem)}
        <span className="sidebar-heading sidebar-heading-gap">SUPPORT</span>{navItem({ id: 'ask', label: 'Ask Protégé', icon: ChatCircleDotsIcon })}
        <span className="sidebar-heading sidebar-heading-gap">ORGANIZATION</span>{PROFILE.map(navItem)}</nav>
      <div className="sidebar-bottom"><span className="sidebar-status"><span className={session.phase === 'live' ? 'status-live' : ''} />{session.phase === 'live' ? 'Recording now' : 'Ready when you are'}</span><p>Private by design. Your guides stay on this computer.</p></div>
    </aside>
    <div className="desktop-workspace"><header className="desktop-topbar"><div><span className="workspace-kicker">{mode === 'expert' ? 'EXPERT WORKSPACE' : 'NEW HIRE WORKSPACE'}</span><strong>{title}</strong></div>
      <div className="desktop-top-actions"><button className="top-ask" onClick={() => go('ask')}><ChatCircleDotsIcon size={17} /> Ask AI <span>Ctrl Shift Space</span></button><button className="top-company" onClick={() => go('company')}><BuildingsIcon size={17} /> {settings.company}</button></div></header>
      <main className={`shell-main page-${page}`}>
        <div hidden={page !== 'ask'}><AskPage bridge={bridge} /></div>
        {content}
      </main>
    </div>
    {replay && <ReplayDialog replay={replay} close={() => setReplay(null)} />}
  </div>
}

function ReplayDialog({ replay, close }: { replay: ReplayCommand; close: () => void }) {
  const [index, setIndex] = useState(0)
  const steps = replay.steps.filter((step: GuideStep) => step.shot)
  const step = steps[Math.min(index, steps.length - 1)]
  return <div className="replay-backdrop" role="presentation" onMouseDown={close}><section className="replay-dialog" role="dialog" aria-modal="true" aria-label="Expert example" onMouseDown={(e) => e.stopPropagation()}>
    <header><div><span className="workspace-kicker">EXPERT EXAMPLE</span><h2>{replay.title || 'How the expert did this step'}</h2></div><button onClick={close} aria-label="Close example"><XIcon size={20} /></button></header>
    {step?.shot ? <img src={shotUrl(step.shot)} alt={step.screen_moment || step.title} /> : <p>No screenshot is available for this step.</p>}
    {step && <p><strong>{step.n}. {step.title}</strong>{step.quote && <span> “{step.quote.text}”</span>}</p>}
    {steps.length > 1 && <footer><button disabled={index === 0} onClick={() => setIndex(index - 1)}>Previous</button><span>{index + 1} of {steps.length}</span><button disabled={index === steps.length - 1} onClick={() => setIndex(index + 1)}>Next</button></footer>}
  </section></div>
}
