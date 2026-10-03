// Observer service (Agent A): runs the Python sidecar and bridges it to the main-process bus.
//
// - Spawns `python sidecar/observer.py`, reads JSON lines (events + replies) from stdout,
//   writes commands to stdin. Shapes: shared/contracts.ts.
// - Every event is re-emitted as bus 'observer:event'. Requests 'observer:*' become commands.
// - Restarts the sidecar if it dies (1 s, 2 s, 5 s, 10 s, then every 30 s) and keeps the mode.
// - OBSERVER_FAKE=<fixture.jsonl> replays a fixture instead of spawning Python.
//
// Screenshot paths in events and replies are relative to ctx.paths.root ("shots/...").
// Uses no Electron APIs, so it can be tested in plain Node.

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import { createInterface } from 'node:readline'
import type {
  AppContext,
  Mode,
  ServiceInit,
  SidecarCommand,
  SidecarEvent,
  SidecarReply,
  WarningEvent
} from '@shared/contracts'

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
export type CommandBody = DistributiveOmit<SidecarCommand, 'id'>

export interface Requester {
  start(): void
  stop(): void
  request(body: CommandBody, timeoutMs?: number): Promise<SidecarReply>
  setMode(mode: Mode): void
}

const RESTART_DELAYS_MS = [1000, 2000, 5000, 10000, 30000]
const HEALTHY_RUN_MS = 60_000

function nowSeconds(): number {
  return Date.now() / 1000
}

function warning(code: WarningEvent['code'], detail: string): WarningEvent {
  return { type: 'warning', t: nowSeconds(), code, detail }
}

export interface ObserverOptions {
  python: string
  script: string
  /** Extra args after the script (the client adds --mode itself). */
  args: string[]
  onEvent: (ev: SidecarEvent) => void
  log?: (msg: string) => void
  env?: NodeJS.ProcessEnv
  restartDelaysMs?: number[]
  spawnFn?: typeof spawn
}

interface Pending {
  resolve: (reply: SidecarReply) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class ObserverClient implements Requester {
  private child: ChildProcess | null = null
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private stopped = false
  private failures = 0
  private startedAt = 0
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private mode: Mode = 'ambient'

  constructor(private readonly opts: ObserverOptions) {}

  start(): void {
    this.stopped = false
    this.spawnChild()
  }

  stop(): void {
    this.stopped = true
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    this.rejectAll(new Error('observer stopped'))
    const child = this.child
    this.child = null
    if (child) {
      child.stdin?.end() // EOF makes the sidecar exit cleanly
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill()
      }, 2000).unref?.()
    }
  }

  setMode(mode: Mode): void {
    this.mode = mode
  }

  request(body: CommandBody, timeoutMs = 3000): Promise<SidecarReply> {
    const child = this.child
    if (!child || !child.stdin || child.stdin.destroyed) {
      return Promise.reject(new Error('observer is not running'))
    }
    const id = this.nextId++
    return new Promise<SidecarReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`observer did not answer '${body.cmd}' within ${timeoutMs} ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      child.stdin!.write(JSON.stringify({ ...body, id }) + '\n', (err) => {
        if (err) {
          clearTimeout(timer)
          this.pending.delete(id)
          reject(err)
        }
      })
    })
  }

  /** Handle one stdout line from the sidecar (public for tests). */
  handleLine(line: string): void {
    const text = line.trim()
    if (!text) return
    let obj: unknown
    try {
      obj = JSON.parse(text)
    } catch {
      this.log(`[observer] ignoring a non-JSON line: ${text.slice(0, 120)}`)
      return
    }
    if (!obj || typeof obj !== 'object') return
    const rec = obj as Record<string, unknown>
    if (typeof rec.id === 'number' && typeof rec.ok === 'boolean') {
      const p = this.pending.get(rec.id)
      if (p) {
        clearTimeout(p.timer)
        this.pending.delete(rec.id)
        p.resolve(rec as unknown as SidecarReply)
      }
      return
    }
    if (typeof rec.type === 'string') this.opts.onEvent(rec as unknown as SidecarEvent)
  }

  private log(msg: string): void {
    ;(this.opts.log ?? console.error)(msg)
  }

  private spawnChild(): void {
    const spawnFn = this.opts.spawnFn ?? spawn
    const args = [this.opts.script, ...this.opts.args, '--mode', this.mode]
    let child: ChildProcess
    try {
      child = spawnFn(this.opts.python, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, ...this.opts.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' }
      })
    } catch (err) {
      this.log(`[observer] could not start ${this.opts.python}: ${String(err)}`)
      this.scheduleRestart()
      return
    }
    this.child = child
    this.startedAt = Date.now()
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    if (child.stdout) createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (l) => this.handleLine(l))
    if (child.stderr) createInterface({ input: child.stderr, crlfDelay: Infinity }).on('line', (l) => this.log(l))
    child.stdin?.on('error', () => {
      /* the process died; 'exit' handles it */
    })
    let ended = false
    const onEnd = (why: string): void => {
      if (ended) return // 'error' and 'exit' can both fire for one process
      ended = true
      if (this.child === child) this.child = null
      this.rejectAll(new Error(why))
      if (!this.stopped) {
        this.log(`[observer] ${why}; restarting`)
        this.scheduleRestart()
      }
    }
    child.on('error', (err: Error) => {
      const code = (err as NodeJS.ErrnoException).code
      const hint = code === 'ENOENT' ? ' (Python not found: install it or set APPRENTICE_PYTHON)' : ''
      this.log(`[observer] ${err.message}${hint}`)
      if (child.pid === undefined) onEnd(`could not start the sidecar: ${err.message}`) // no 'exit' follows
    })
    child.on('exit', (code, signal) => onEnd(`sidecar exited (code ${code}, signal ${signal})`))
  }

  private scheduleRestart(): void {
    if (this.stopped || this.restartTimer) return
    if (Date.now() - this.startedAt > HEALTHY_RUN_MS) this.failures = 0
    const delays = this.opts.restartDelaysMs ?? RESTART_DELAYS_MS
    const delay = delays[Math.min(this.failures, delays.length - 1)]
    this.failures++
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (this.stopped) return
      this.opts.onEvent(warning('sidecar_restarted', `observer restarted after a crash (attempt ${this.failures})`))
      this.spawnChild()
    }, delay)
  }

  private rejectAll(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(err)
      this.pending.delete(id)
    }
  }
}

/** OBSERVER_FAKE: replays a JSONL fixture of SidecarEvents with their original timing. */
export class FakeReplay implements Requester {
  private timers: ReturnType<typeof setTimeout>[] = []

  constructor(
    private readonly file: string,
    private readonly onEvent: (ev: SidecarEvent) => void,
    private readonly speed = 1,
    private readonly log: (msg: string) => void = console.error
  ) {}

  start(): void {
    this.onEvent({ type: 'ready', t: nowSeconds(), version: 'fixture', platform: process.platform, backend: 'fake', dpi_awareness: 'unknown' })
    let events: SidecarEvent[] = []
    try {
      events = parseFixture(readFileSync(this.file, 'utf8'))
    } catch (err) {
      this.log(`[observer] could not read fixture ${this.file}: ${String(err)}`)
      return
    }
    let delayMs = 0
    let prevT = events.length ? events[0].t : 0
    const started = nowSeconds()
    for (const ev of events) {
      if (ev.type === 'ready') continue
      delayMs += (Math.min(Math.max(ev.t - prevT, 0), 3) * 1000) / this.speed // gaps capped at 3 s
      prevT = ev.t
      const at = delayMs
      this.timers.push(setTimeout(() => this.onEvent({ ...ev, t: started + at / 1000 }), at))
    }
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t)
    this.timers = []
  }

  setMode(): void {}

  request(body: CommandBody): Promise<SidecarReply> {
    switch (body.cmd) {
      case 'redact':
        return Promise.resolve({ id: 0, ok: true, text: body.text })
      case 'tree':
        return Promise.resolve({ id: 0, ok: true, controls: [] })
      case 'shot':
        return Promise.resolve({ id: 0, ok: false, error: 'screenshots are not available in fake mode' })
      default:
        return Promise.resolve({ id: 0, ok: true })
    }
  }
}

/** Parse a fixture: one SidecarEvent per line; blank lines and // or # comments are skipped. */
export function parseFixture(text: string): SidecarEvent[] {
  const out: SidecarEvent[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('//') || line.startsWith('#')) continue
    const obj = JSON.parse(line) as Record<string, unknown>
    if (typeof obj.type === 'string' && typeof obj.t === 'number') out.push(obj as unknown as SidecarEvent)
  }
  return out
}

export function resolveSidecarScript(): string {
  const dir = typeof __dirname === 'string' ? __dirname : process.cwd()
  const candidates = [
    process.env.APPRENTICE_SIDECAR,
    path.resolve(process.cwd(), '..', 'sidecar', 'observer.py'), // npm run dev inside app/
    path.resolve(process.cwd(), 'sidecar', 'observer.py'), // started from the repo root
    path.resolve(dir, '..', '..', '..', 'sidecar', 'observer.py') // app/out/main -> repo root
  ].filter((p): p is string => !!p)
  return candidates.find((p) => existsSync(p)) ?? candidates[0]
}

export function resolvePython(): string {
  return process.env.APPRENTICE_PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
}

function requireOk(reply: SidecarReply, what: string): SidecarReply {
  if (!reply.ok) throw new Error(`${what}: ${reply.error ?? 'failed'}`)
  return reply
}

export function registerHandlers(ctx: AppContext, client: Requester): void {
  ctx.bus.handle('observer:redact', async ({ text }) => {
    // Callers must not store the raw text if this rejects.
    const r = requireOk(await client.request({ cmd: 'redact', text }, 2000), 'redact')
    if (typeof r.text !== 'string') throw new Error('redact: no text in reply')
    return { text: r.text }
  })
  ctx.bus.handle('observer:tree', async ({ max }) => {
    const r = await client.request({ cmd: 'tree', max }, 5000)
    return { controls: r.ok ? r.controls ?? [] : [] } // blocked or vision mode: empty -> fall back to vision
  })
  ctx.bus.handle('observer:mode', async ({ value }) => {
    client.setMode(value)
    const r = await client.request({ cmd: 'mode', value }, 3000)
    return { ok: r.ok }
  })
  ctx.bus.handle('observer:shot', async () => {
    const r = requireOk(await client.request({ cmd: 'shot', reason: 'on_demand' }, 5000), 'shot')
    if (!r.path || !r.meta) throw new Error('shot: no path in reply')
    return { path: r.path, meta: r.meta }
  })
  ctx.bus.handle('observer:setCapture', async ({ key, value }) => {
    const r = await client.request({ cmd: 'set_capture', key, value }, 3000)
    return { ok: r.ok }
  })
  ctx.bus.handle('observer:a11yAck', async ({ key, choice }) => {
    const r = await client.request({ cmd: 'a11y_ack', key, choice }, 3000)
    return { ok: r.ok }
  })
  ctx.bus.handle('observer:reloadConfig', async () => {
    const r = await client.request({ cmd: 'reload_config' }, 3000)
    return { ok: r.ok }
  })
}

export const init: ServiceInit = (ctx) => {
  const onEvent = (ev: SidecarEvent): void => ctx.bus.emit('observer:event', ev)
  let client: Requester
  if (ctx.env.OBSERVER_FAKE) {
    const speed = Number(process.env.OBSERVER_FAKE_SPEED) || 1
    client = new FakeReplay(path.resolve(ctx.env.OBSERVER_FAKE), onEvent, speed)
  } else {
    client = new ObserverClient({
      python: resolvePython(),
      script: resolveSidecarScript(),
      args: ['--data-dir', ctx.paths.root, '--config-dir', ctx.paths.config, '--parent-pid', String(process.pid)],
      onEvent
    })
  }
  registerHandlers(ctx, client)
  client.start()
  process.once('exit', () => client.stop())
}
