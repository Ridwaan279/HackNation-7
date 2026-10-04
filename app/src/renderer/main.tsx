import { Suspense, lazy, type ComponentType } from 'react'
import { createRoot } from 'react-dom/client'
import './base.css'

type Page = () => Promise<{ default: ComponentType }>

// Agent C owns src/renderer/dashboard/ (entry: index.tsx, default export). Until it exists, show the dev dashboard.
const dashboards = import.meta.glob<{ default: ComponentType }>(['./dashboard/index.tsx', './dashboard/Dashboard.tsx'])
const dashboard = dashboards['./dashboard/index.tsx'] ?? dashboards['./dashboard/Dashboard.tsx']

const routes: Record<string, Page> = {
  overlay: () => import('./overlay/Overlay'),
  panel: () => import('./panel/Panel'),
  dashboard: dashboard ?? (() => import('./devtools/DevDashboard')),
}

// One renderer, hash routes: #/overlay, #/panel, #/dashboard[/anything]
const TITLES: Record<string, string> = { overlay: 'Protégé overlay', panel: 'Protégé', dashboard: 'Protégé' }
const route = location.hash.replace(/^#\/?/, '').split(/[/?]/)[0] || 'dashboard'
document.documentElement.dataset.route = route
document.title = TITLES[route] ?? 'Protégé'
const Page = lazy(routes[route] ?? routes.dashboard)

createRoot(document.getElementById('root')!).render(
  <Suspense fallback={null}>
    <Page />
  </Suspense>
)
