import { app, BrowserWindow, Menu, screen, type BrowserWindowConstructorOptions } from 'electron'
import { join } from 'node:path'
import type { AppContext, Rect, ServiceInit } from '@shared/contracts'
import type { OverlayGeometry } from '../../common/ipc'

let ctx: AppContext | null = null
let overlay: BrowserWindow | null = null
let panel: BrowserWindow | null = null
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

function createPanel() {
  const { workArea } = screen.getPrimaryDisplay()
  const width = 400
  const height = Math.min(720, workArea.height - 40)
  panel = new BrowserWindow({
    // Left of the ghost's dock in the bottom-right corner, so the ghost never covers it.
    x: workArea.x + workArea.width - width - 190,
    y: workArea.y + workArea.height - height - 20,
    width,
    height,
    minWidth: 320,
    title: 'Apprentice',
    show: false,
    alwaysOnTop: true,
    backgroundColor: '#0d0b1a',
    autoHideMenuBar: true,
    webPreferences: webPreferences(),
  })
  hideOnClose(panel)
  panel.once('ready-to-show', () => panel?.show())
  load(panel, 'panel')
}

function createDashboard() {
  dashboard = new BrowserWindow({
    width: 1280,
    height: 820,
    title: 'Apprentice Dashboard',
    show: false,
    backgroundColor: '#0d0b1a',
    autoHideMenuBar: true,
    webPreferences: webPreferences(),
  })
  hideOnClose(dashboard)
  dashboard.once('ready-to-show', () => dashboard?.show())
  load(dashboard, 'dashboard')
}

export function createWindows() {
  createOverlay()
  createPanel()
  createDashboard()
}

export function showPanel() {
  if (!panel || panel.isDestroyed()) return
  panel.showInactive()
}

export function togglePanel() {
  if (!panel || panel.isDestroyed()) return
  if (panel.isVisible()) panel.hide()
  else panel.show()
}

export function openDashboard(path?: string) {
  if (!dashboard || dashboard.isDestroyed()) return
  if (path) load(dashboard, `dashboard/${path.replace(/^\/+/, '')}`)
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
      { label: 'Open panel', click: () => panel?.show() },
      { label: 'Open dashboard', click: () => openDashboard() },
      { type: 'separator' },
      { label: 'Quit Apprentice', click: () => quit() },
    ]).popup({ window: overlay ?? undefined })
  })
}
