import { app, BrowserWindow, Menu, screen, type BrowserWindowConstructorOptions } from 'electron'
import { join } from 'node:path'
import type { AppContext, Rect, ServiceInit } from '@shared/contracts'
import type { OverlayGeometry } from '../../common/ipc'

let ctx: AppContext | null = null
let overlay: BrowserWindow | null = null
let dashboard: BrowserWindow | null = null
let quitting = false

const preload = () => join(app.getAppPath(), 'out/preload/index.js')

function load(win: BrowserWindow, route: string) {
  const dev = process.env.ELECTRON_RENDERER_URL
  if (dev) win.loadURL(`${dev}#/${route}`)
  else win.loadFile(join(app.getAppPath(), 'out/renderer/index.html'), { hash: `/${route}` })
}

function webPreferences(extra: BrowserWindowConstructorOptions['webPreferences'] = {}) {
  return { preload: preload(), contextIsolation: true, sandbox: false, ...extra }
}

/** Hide instead of close, so the app keeps running with only the ghost visible. */
function hideOnClose(win: BrowserWindow) {
  win.on('close', (e) => {
    if (quitting) return
    e.preventDefault()
    win.hide()
  })
}

export function overlayGeometry(): OverlayGeometry {
  const d = screen.getPrimaryDisplay()
  return { bounds: overlay?.getBounds() ?? d.bounds, workArea: d.workArea }
}

/** Screen DIP rect -> overlay-local DIP rect (what the ghost uses). */
export function toOverlayLocal(rect: Rect): Rect {
  const { x, y } = overlayGeometry().bounds
  return [rect[0] - x, rect[1] - y, rect[2] - x, rect[3] - y]
}

function createOverlay() {
  const { bounds } = screen.getPrimaryDisplay()
  overlay = new BrowserWindow({
    ...bounds,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    // Never steal focus from the app being observed.
    focusable: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: webPreferences({ autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false }),
  })
  overlay.setAlwaysOnTop(true, 'screen-saver')
  overlay.setIgnoreMouseEvents(true, { forward: true })
  // Hides the ghost from screenshots, but also from OBS/Zoom/screen recordings (PLAN §5.10, §12).
  if (process.env.GHOST_CONTENT_PROTECTION === '1') overlay.setContentProtection(true)
  overlay.once('ready-to-show', () => overlay?.showInactive())
  if (process.env.OVERLAY_DEVTOOLS === '1') overlay.webContents.openDevTools({ mode: 'detach' })
  hideOnClose(overlay)
  load(overlay, 'overlay')

  const refit = () => {
    if (!overlay || overlay.isDestroyed()) return
    overlay.setBounds(screen.getPrimaryDisplay().bounds)
    ctx?.broadcast('overlay:geometry', overlayGeometry())
  }
  screen.on('display-metrics-changed', refit)
  screen.on('display-added', refit)
  screen.on('display-removed', refit)
}

function createDashboard() {
  dashboard = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 860,
    minHeight: 620,
    title: 'Protégé',
    show: false,
    backgroundColor: '#050505',
    autoHideMenuBar: true,
    webPreferences: webPreferences(),
  })
  hideOnClose(dashboard)
  dashboard.once('ready-to-show', () => dashboard?.show())
  load(dashboard, 'dashboard')
}

export function createWindows() {
  createOverlay()
  createDashboard()
}

export function showPanel() {
  openDashboard()
}

export function togglePanel() {
  openDashboard('ask')
}

export function openDashboard(path?: string) {
  if (!dashboard || dashboard.isDestroyed()) return
  if (path) {
    const navigate = () => dashboard?.webContents.send('dashboard:navigate', path.replace(/^\/+/, ''))
    if (dashboard.webContents.isLoading()) dashboard.webContents.once('did-finish-load', navigate)
    else navigate()
  }
  dashboard.show()
  dashboard.focus()
}

export function quit() {
  quitting = true
  app.quit()
}

app.on('before-quit', () => {
  quitting = true
})

export const init: ServiceInit = (c) => {
  ctx = c
  c.handle('overlay:setInteractive', (interactive: boolean) => {
    overlay?.setIgnoreMouseEvents(!interactive, { forward: true })
  })
  c.handle('overlay:geometry', () => overlayGeometry())
  c.handle('panel:toggle', () => togglePanel())
  c.handle('panel:show', () => showPanel())
  c.handle('dashboard:open', (p?: { path?: string }) => openDashboard(p?.path))
  c.handle('app:quit', () => quit())
  c.handle('ghost:menu', () => {
    Menu.buildFromTemplate([
      { label: 'Ask Protégé', click: () => openDashboard('ask') },
      { label: 'Record a task', click: () => openDashboard('record?new=1') },
      { label: 'Open dashboard', click: () => openDashboard() },
      { type: 'separator' },
      { label: 'Quit Protégé', click: () => quit() },
    ]).popup({ window: overlay ?? undefined })
  })
}
