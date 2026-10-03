import { app, BrowserWindow, desktopCapturer, ipcMain, net, protocol, session } from 'electron'
import { mkdirSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import dotenv from 'dotenv'
import type { AppContext, BusEvents, ServiceInit, SidecarEvent } from '@shared/contracts'
import { createBus } from './bus'
import { createWindows } from './services/windows'

// app/.env (in dev, getAppPath() is the app/ folder).
dotenv.config({ path: join(app.getAppPath(), '.env'), quiet: true })

if (!app.requestSingleInstanceLock()) app.quit()

// apx://file/?p=<path> serves files under %APPDATA%/apprentice (screenshots) to the renderers.
protocol.registerSchemesAsPrivileged([
  { scheme: 'apx', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
])

const root = join(app.getPath('appData'), 'apprentice')
const paths: AppContext['paths'] = {
  root,
  sessions: join(root, 'sessions'),
  memory: join(root, 'memory'),
  config: join(root, 'config'),
  shots: join(root, 'shots'),
}

/** Bus events every window receives on the channel of the same name. */
const FORWARDED: (keyof BusEvents)[] = [
  'guide:updated',
  'workmap:updated',
  'profile:updated',
  'tutor:violation',
  'popup:show',
  'ghost:state',
  'session:started',
  'session:stopped',
  'transcript:line',
  'agent:answer',
]
/** Too chatty (activity) or not needed in windows (ambient text). */
const NOT_FORWARDED: SidecarEvent['type'][] = ['activity', 'text']

/** Services that start pushing events should init last, once everyone is listening. */
const INIT_LAST = ['observer']

function createContext(): AppContext {
  const bus = createBus()
  const env = {
    MODEL_FAST: process.env.MODEL_FAST ?? '',
    MODEL_SMART: process.env.MODEL_SMART ?? '',
    OBSERVER_FAKE: process.env.OBSERVER_FAKE || undefined,
  }
  if (!env.MODEL_FAST || !env.MODEL_SMART) console.warn('[env] MODEL_FAST / MODEL_SMART not set in app/.env')

  return {
    bus,
    paths,
    env,
    handle(channel, fn) {
      try {
        ipcMain.handle(channel, (_e, payload) => fn(payload))
      } catch (err) {
        console.error(`[ipc] could not register "${channel}" (registered twice?)`, err)
      }
    },
    broadcast(channel, payload) {
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send(channel, payload)
      }
    },
  }
}

/** Calls init on every src/main/services/*.ts that exists. A failing service is logged and skipped. */
async function loadServices(ctx: AppContext) {
  const loaders = import.meta.glob<{ init?: ServiceInit }>('./services/*.ts')
  const name = (file: string) => basename(file, '.ts')
  const files = Object.keys(loaders).sort(
    (a, b) => Number(INIT_LAST.includes(name(a))) - Number(INIT_LAST.includes(name(b))) || a.localeCompare(b)
  )
  for (const file of files) {
    try {
      const mod = await loaders[file]()
      if (typeof mod.init !== 'function') {
        console.warn(`[services] ${name(file)} has no init export; skipped`)
        continue
      }
      // Don't let one slow init block the rest.
      const done = Promise.resolve(mod.init(ctx))
      const slow = new Promise((r) => setTimeout(() => r('slow'), 3000))
      if ((await Promise.race([done, slow])) === 'slow') console.warn(`[services] ${name(file)} init still running; continuing`)
      done.catch((err) => console.error(`[services] ${name(file)} init failed:`, err))
      console.log(`[services] ${name(file)} ready`)
    } catch (err) {
      console.error(`[services] ${name(file)} failed to load:`, err)
    }
  }
}

function forwardBusToWindows(ctx: AppContext) {
  for (const ev of FORWARDED) ctx.bus.on(ev, (payload) => ctx.broadcast(ev, payload))
  ctx.bus.on('observer:event', (e) => {
    if (!NOT_FORWARDED.includes(e.type)) ctx.broadcast('observer:event', e)
  })
}

function registerFileProtocol() {
  protocol.handle('apx', (request) => {
    const p = new URL(request.url).searchParams.get('p') ?? ''
    const abs = isAbsolute(p) ? resolve(p) : resolve(root, p)
    const rel = relative(root, abs)
    if (rel.startsWith('..') || isAbsolute(rel)) return new Response('forbidden', { status: 403 })
    return net.fetch(pathToFileURL(abs).toString())
  })
}

function registerPermissions() {
  const allowed = new Set(['media', 'display-capture', 'audioCapture', 'speaker-selection'])
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)))
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission))
  // Optional MediaRecorder session video: hand over the primary screen without a picker.
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, cb) => {
    const [screen] = await desktopCapturer.getSources({ types: ['screen'] })
    cb(screen ? { video: screen } : {})
  })
}

app.whenReady().then(async () => {
  for (const p of Object.values(paths)) mkdirSync(p, { recursive: true })
  registerFileProtocol()
  registerPermissions()

  const ctx = createContext()
  forwardBusToWindows(ctx)
  await loadServices(ctx)
  createWindows()
})

app.on('window-all-closed', () => app.quit())
