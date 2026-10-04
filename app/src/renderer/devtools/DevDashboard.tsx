// Shown at #/dashboard until Agent C's src/renderer/dashboard/index.tsx is merged.
// Doubles as Agent B's test bench: ghost states, pop-ups, pointer, live event log.
import { useState } from 'react'
import type { GhostState, Guide, Popup, SidecarEvent } from '@shared/contracts'
import { Ghost } from '../mascot/Ghost'
import { tryInvoke, useChannel } from '../lib/api'
import './dev.css'

const STATES: GhostState[] = ['idle', 'listening', 'thinking', 'speaking', 'flying', 'pointing', 'alert', 'not_watching']

const SAMPLE_POPUPS: Popup[] = [
  {
    id: 'dev-a11y',
    kind: 'a11y_blind',
    app_key: 'msedge.exe',
    text: "I can't read Edge. Want me to watch it by screen recording instead?",
    speak: true,
    choices: [
      { id: 'yes', label: 'Yes, record it' },
      { id: 'not_now', label: 'Not now' },
      { id: 'never', label: 'Never watch this app' },
    ],
  },
  {
    id: 'dev-curiosity',
    kind: 'curiosity',
    text: 'Got a sec? Why do some invoices go for a second approval?',
    speak: false,
    choices: [
      { id: 'yes', label: 'Sure' },
      { id: 'later', label: 'Later' },
    ],
  },
]

// Screenshots live in %APPDATA%/apprentice/shots/demo/ (copied from Agent C's fixtures).
const step = (n: number, kind: Guide['steps'][number]['kind'], title: string, shot: string | null, quote?: string) => ({
  id: `demo-${n}`, n, t: n * 9, kind, title, note: '', target: '', shot, highlight: null, blur: [], screen_moment: title,
  edited: false, ...(quote ? { quote: { text: quote, t: n * 9 } } : {}),
})
const SAMPLE_GUIDE: Guide = {
  id: 'demo-guide',
  title: 'Process a supplier invoice in MiniERP',
  app: 'browser:minierp.local',
  session: '',
  steps: [
    step(1, 'click', 'Open invoice 4471 from Müller GmbH', 'shots/demo/expert-capex.jpg'),
    step(2, 'enter', 'Enter 0400 in Cost center', null, 'Equipment over €5,000 is always capex.'),
    step(3, 'click', 'Click Hold', 'shots/demo/expert-hold.jpg', 'They double-bill every December, so I hold it until I check.'),
    step(4, 'click', 'Click Send for approval', 'shots/demo/expert-approval.jpg'),
  ],
}

export default function DevDashboard() {
  const [log, setLog] = useState<string[]>([])
  const push = (line: string) => setLog((l) => [line, ...l].slice(0, 200))

  useChannel<SidecarEvent>('observer:event', (e) => push(`observer ${e.type} ${JSON.stringify(e).slice(0, 160)}`))
  for (const ch of ['session:state', 'ghost:state', 'transcript:line', 'agent:answer', 'popup:show', 'guide:updated']) {
    // Fixed list, so the hook order is stable.
    useChannel<unknown>(ch, (p) => push(`${ch} ${JSON.stringify(p).slice(0, 200)}`))
  }

  const pointAtCenter = () => {
    const s = window.screen
    // Physical px of a box in the middle of the primary screen.
    const r = devicePixelRatio
    const w = 240 * r
    const h = 60 * r
    const cx = (s.width * r) / 2
    const cy = (s.height * r) / 2
    void tryInvoke('dev:point', { rect: [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2], label: 'Screen centre' })
  }

  return (
    <div className="dev">
      <header>
        <h1>Protégé · dev dashboard</h1>
        <p className="muted">Agent C's dashboard replaces this once src/renderer/dashboard/index.tsx is merged.</p>
      </header>

      <section>
        <h2>Ghost states</h2>
        <div className="gallery">
          {STATES.map((s) => (
            <figure key={s}>
              <Ghost state={s} pose={s === 'flying' ? 'right' : 'front'} badge={s === 'idle' ? 'recording' : s === 'listening' ? 'vision' : null} volume={s === 'speaking' ? 0.6 : 0} size={150} />
              <figcaption>{s}</figcaption>
            </figure>
          ))}
        </div>
      </section>

      <section>
        <h2>Overlay tests</h2>
        <div className="row">
          {SAMPLE_POPUPS.map((p) => (
            <button key={p.id} onClick={() => void tryInvoke('dev:emit', { name: 'popup:show', payload: { ...p, id: `${p.id}-${Date.now()}` } })}>
              Pop-up: {p.kind}
            </button>
          ))}
          <button onClick={pointAtCenter}>Pointer to screen centre</button>
          <button onClick={() => void tryInvoke('dev:emit', { name: 'guide:updated', payload: SAMPLE_GUIDE })}>Sample guide in panel</button>
          <button onClick={() => void tryInvoke('dev:emit', { name: 'ghost:state', payload: { state: 'alert', badge: null } })}>Ghost alert</button>
          <button onClick={() => void tryInvoke('dev:emit', { name: 'ghost:state', payload: { state: 'not_watching', badge: null } })}>Not watching</button>
          <button onClick={() => void tryInvoke('dev:emit', { name: 'ghost:state', payload: { state: 'idle', badge: null } })}>Reset ghost</button>
        </div>
      </section>

      <section>
        <h2>Live events</h2>
        <pre className="log">{log.join('\n') || 'Nothing yet. Set OBSERVER_FAKE or press Record in the panel.'}</pre>
      </section>
    </div>
  )
}
