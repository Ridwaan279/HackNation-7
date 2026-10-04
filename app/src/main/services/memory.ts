// Ambient memory (PLAN §5.2, §6.6): masked per-app daily logs in memory/<app>/<date>.jsonl, active
// minutes per app, raw-log retention, and delete per app / per day / everything.
// Events reach this service already masked by the sidecar; nothing is written for blocked windows,
// while paused or off the record (the sidecar sends nothing then), or during tutor lessons.
import { mkdir, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { AppContext, MemoryApp, MemoryEntry, PrivacyConfig, ServiceInit, SidecarEvent } from '@shared/contracts'
import { appDirectory, getStore } from './store'

/** Inputs further apart than this don't count as continuous use. */
const ACTIVE_GAP_S = 60
const STATS_FLUSH_MS = 30_000
const RETENTION_EVERY_MS = 6 * 3600_000
const HASH = /^[0-9a-f]{64}$/
const DAY = /^\d{4}-\d{2}-\d{2}$/

export interface AppStats {
  key: string
  minutes: number
  last_seen: string
  bytes: number
  /** Totals at the last App Profile rollup. */
  rollup: { minutes: number; bytes: number; t: number }
}

const dayOf = (t: number) => new Date(t * 1000).toISOString().slice(0, 10)
const keySchema = z.string().min(1).max(300)
const daySchema = z.string().regex(DAY)

export function createMemory(ctx: AppContext, options: { now?: () => number } = {}) {
  const store = getStore(ctx)
  const now = options.now ?? (() => Date.now() / 1000)
  const stats = new Map<string, AppStats>()
  const dirty = new Set<string>()
  let loaded: Promise<void> | null = null
  let current: { key: string; title: string } | null = null
  let lastInput: { key: string; t: number } | null = null
  let tutor = false
  const pending = new Set<Promise<unknown>>()
  const track = (task: Promise<unknown>) => {
    pending.add(task)
    void task.catch((error) => console.error('[memory]', error)).finally(() => pending.delete(task))
  }

  async function appDirs(): Promise<string[]> {
    try { return (await readdir(ctx.paths.memory, { withFileTypes: true })).filter((d) => d.isDirectory() && HASH.test(d.name)).map((d) => d.name) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  }
  function load(): Promise<void> {
    loaded ??= (async () => {
      for (const dir of await appDirs()) {
        const saved = await store.read<AppStats>(['memory', dir, 'stats.json']).catch(() => null)
        if (saved?.key && appDirectory(saved.key) === dir && !stats.has(saved.key)) stats.set(saved.key, saved)
      }
    })()
    return loaded
  }
  function statsFor(key: string): AppStats {
    let s = stats.get(key)
    if (!s) { s = { key, minutes: 0, last_seen: new Date(now() * 1000).toISOString(), bytes: 0, rollup: { minutes: 0, bytes: 0, t: 0 } }; stats.set(key, s) }
    return s
  }
  async function flush(): Promise<void> {
    for (const key of [...dirty]) {
      dirty.delete(key)
      const s = stats.get(key)
      if (s) await store.write(['memory', appDirectory(key), 'stats.json'], s)
    }
  }

  function write(entry: MemoryEntry): void {
    const s = statsFor(entry.key)
    const line = JSON.stringify(entry)
    s.bytes += line.length + 1
    s.last_seen = new Date(entry.t * 1000).toISOString()
    dirty.add(entry.key)
    track(store.append(['memory', appDirectory(entry.key), `${dayOf(entry.t)}.jsonl`], entry))
  }

  /** Continuous input in the same app counts as active time. */
  function input(key: string, t: number): void {
    if (lastInput && lastInput.key === key) {
      const gap = t - lastInput.t
      if (gap > 0 && gap <= ACTIVE_GAP_S) { statsFor(key).minutes += gap / 60; dirty.add(key) }
    }
    lastInput = { key, t }
  }

  function onEvent(event: SidecarEvent): void {
    if (event.type === 'blocked') { current = null; lastInput = null; return }
    if (event.type === 'context') {
      const changed = !current || current.key !== event.key || current.title !== event.title
      current = { key: event.key, title: event.title }
      if (changed && !tutor) write({ type: 'context', t: event.t, key: event.key, title: event.title })
      return
    }
    if (!current || tutor) return
    switch (event.type) {
      case 'text':
        if (event.delta.length) write({ type: 'text', t: event.t, key: event.key, title: event.title, lines: event.delta })
        break
      case 'commit':
        write({ type: 'commit', t: event.t, key: current.key, field: event.field, old: event.old, new: event.new, masked: event.masked })
        input(current.key, event.t)
        break
      case 'click':
        if (event.target) write({ type: 'click', t: event.t, key: current.key, target: event.target.name, control_type: event.target.control_type })
        input(current.key, event.t)
        break
      case 'selection':
        // What the user highlighted (PDFs, documents, web pages), already masked by the sidecar.
        write({ type: 'highlight', t: event.t, key: event.key, title: event.title, text: event.text })
        input(current.key, event.t)
        break
      case 'activity':
        input(current.key, event.t)
        break
    }
  }

  async function apps(): Promise<MemoryApp[]> {
    await load()
    const out: MemoryApp[] = []
    const seen = new Set<string>()
    for (const s of stats.values()) seen.add(appDirectory(s.key))
    // Apps with only screen descriptions (written by describe.ts) have no stats yet.
    for (const dir of await appDirs()) {
      if (seen.has(dir)) continue
      const days = (await store.list(['memory', dir])).filter((f) => DAY.test(f.slice(0, -6)))
      const first = days.length ? (await store.lines<MemoryEntry>(['memory', dir, days[days.length - 1]]).catch(() => []))[0] : undefined
      if (first?.key && appDirectory(first.key) === dir) statsFor(first.key)
    }
    for (const s of stats.values()) {
      const days = (await store.list(['memory', appDirectory(s.key)])).filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, -6)).filter((d) => DAY.test(d))
      if (!days.length && s.bytes === 0) continue
      out.push({ key: s.key, minutes: Math.round(s.minutes * 10) / 10, last_seen: s.last_seen, bytes: s.bytes, days: days.reverse() })
    }
    return out.sort((a, b) => b.last_seen.localeCompare(a.last_seen))
  }

  async function entries(key: string, day: string, limit = 2000): Promise<MemoryEntry[]> {
    const lines = await store.lines<MemoryEntry>(['memory', appDirectory(keySchema.parse(key)), `${daySchema.parse(day)}.jsonl`])
    return lines.slice(-limit)
  }

  /** Entries newer than t, newest days first, up to maxDays. */
  async function since(key: string, t: number, maxDays = 7): Promise<MemoryEntry[]> {
    const dir = appDirectory(key)
    const days = (await store.list(['memory', dir])).filter((f) => f.endsWith('.jsonl') && DAY.test(f.slice(0, -6))).slice(-maxDays)
    const out: MemoryEntry[] = []
    for (const file of days) out.push(...(await store.lines<MemoryEntry>(['memory', dir, file]).catch(() => [])).filter((e) => e.t > t))
    return out
  }

  async function remove(target: { key?: string; day?: string }): Promise<void> {
    await Promise.allSettled([...pending])
    if (target.key && target.day) {
      await store.remove(['memory', appDirectory(keySchema.parse(target.key)), `${daySchema.parse(target.day)}.jsonl`])
    } else if (target.key) {
      const key = keySchema.parse(target.key)
      await rm(path.join(ctx.paths.memory, appDirectory(key)), { recursive: true, force: true })
      await store.remove(['profiles', `${appDirectory(key)}.json`])
      stats.delete(key)
      dirty.delete(key)
    } else {
      for (const dir of await appDirs()) await rm(path.join(ctx.paths.memory, dir), { recursive: true, force: true })
      for (const file of await store.list(['profiles'])) await store.remove(['profiles', file])
      stats.clear(); dirty.clear()
    }
    ctx.bus.emit('data:cleared', { scope: 'memory', key: target.key })
  }

  /** Raw logs older than raw_retention_days are deleted; App Profiles stay (PLAN §6.6). */
  async function retention(): Promise<number> {
    const privacy = await store.read<PrivacyConfig>(['config', 'privacy.json']).catch(() => null)
    const days = Math.max(1, Number(privacy?.raw_retention_days) || 7)
    const cutoff = dayOf(now() - days * 86400)
    let removed = 0
    for (const dir of await appDirs()) {
      for (const file of await store.list(['memory', dir])) {
        const day = file.slice(0, -6)
        if (file.endsWith('.jsonl') && DAY.test(day) && day < cutoff) { await store.remove(['memory', dir, file]); removed++ }
      }
    }
    return removed
  }

  ctx.bus.on('session:started', (event) => { tutor = event.kind === 'tutor' })
  ctx.bus.on('session:stopped', () => { tutor = false })
  ctx.bus.on('observer:event', onEvent)

  return {
    apps, entries, since, remove, retention, flush,
    stats: async (key: string) => { await load(); return stats.get(key) ?? null },
    allStats: async () => { await load(); return [...stats.values()] },
    markRolledUp: (key: string, t: number) => { const s = statsFor(key); s.rollup = { minutes: s.minutes, bytes: s.bytes, t }; dirty.add(key) },
    current: () => current,
    drain: async () => { while (pending.size) await Promise.allSettled([...pending]); await flush() },
  }
}

const memories = new WeakMap<AppContext, ReturnType<typeof createMemory>>()
export function getMemory(ctx: AppContext): ReturnType<typeof createMemory> {
  let memory = memories.get(ctx)
  if (!memory) { memory = createMemory(ctx); memories.set(ctx, memory) }
  return memory
}

/** Everything the app has stored about the user: memory, profiles, guides, Work Maps, sessions, lessons, screenshots. */
export async function deleteEverything(ctx: AppContext): Promise<void> {
  const memory = getMemory(ctx)
  await memory.remove({})
  const root = path.resolve(ctx.paths.root)
  for (const dir of ['guides', 'workmaps', 'sessions', 'mastery', 'shots', 'references']) {
    const target = path.resolve(root, dir)
    if (!target.startsWith(`${root}${path.sep}`)) throw new Error('Refusing to delete outside the app data directory')
    await rm(target, { recursive: true, force: true })
  }
  for (const dir of Object.values(ctx.paths)) await mkdir(dir, { recursive: true })
  ctx.bus.emit('data:cleared', { scope: 'all' })
}

export const init: ServiceInit = (ctx) => {
  const memory = getMemory(ctx)
  setInterval(() => { void memory.flush().catch(() => undefined) }, STATS_FLUSH_MS).unref?.()
  const sweep = () => { void memory.retention().catch((error) => console.error('[memory] retention', error)) }
  setTimeout(sweep, 10_000).unref?.()
  setInterval(sweep, RETENTION_EVERY_MS).unref?.()
  ctx.handle('memory:list', () => memory.apps())
  ctx.handle('memory:day', (payload) => {
    const { key, day } = z.object({ key: keySchema, day: daySchema }).strict().parse(payload)
    return memory.entries(key, day)
  })
  ctx.handle('memory:delete', async (payload) => {
    const target = z.object({ key: keySchema.optional(), day: daySchema.optional() }).strict().parse(payload ?? {})
    if (target.day && !target.key) throw new Error('Choose an app to delete a day from.')
    await memory.remove(target)
    return memory.apps()
  })
  ctx.handle('data:deleteAll', async () => { await deleteEverything(ctx); return { ok: true } })
}
