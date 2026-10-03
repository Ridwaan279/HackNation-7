import { Suspense, lazy, type ComponentType } from 'react'
import { createRoot } from 'react-dom/client'
import './base.css'

type Page = () => Promise<{ default: ComponentType }>

// Agent C owns src/renderer/dashboard/. Until Dashboard.tsx exists, show the dev dashboard.
const dashboard = import.meta.glob<{ default: ComponentType }>('./dashboard/Dashboard.tsx')['./dashboard/Dashboard.tsx']

const routes: Record<string, Page> = {
  overlay: () => import('./overlay/Overlay'),
  panel: () => import('./panel/Panel'),
  dashboard: dashboard ?? (() => import('./devtools/DevDashboard')),
}

// One renderer, hash routes: #/overlay, #/panel, #/dashboard[/anything]
const TITLES: Record<string, string> = { overlay: 'Apprentice overlay', panel: 'Apprentice', dashboard: 'Apprentice Dashboard' }
const route = location.hash.replace(/^#\/?/, '').split(/[/?]/)[0] || 'dashboard'
document.documentElement.dataset.route = route
document.title = TITLES[route] ?? 'Apprentice'
const Page = lazy(routes[route] ?? routes.dashboard)

createRoot(document.getElementById('root')!).render(
  <Suspense fallback={null}>
    <Page />
  </Suspense>
)
