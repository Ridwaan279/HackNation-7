// App Profiles (PLAN §5.2 step 5): an app's masked memory log → MODEL_FAST → an updated profile.
// Triggers: 10+ active minutes or 20 KB of new log since the last rollup, or the Refresh button.
// Without a model (or for local-only apps) a smaller profile is built locally from the same log.
import { z } from 'zod'
import type { AppContext, AppProfile, Guide, MemoryEntry, ServiceInit, WorkMap } from '@shared/contracts'
import { appDirectory, getStore } from './store'
import { getLlm, readPrompt } from './llm'
import { getMemory } from './memory'

const ROLLUP_MINUTES = 10
const ROLLUP_BYTES = 20 * 1024
const CHECK_EVERY_MS = 60_000
const LOG_BUDGET = 24_000 // about 6k tokens

export const profileSchema = z.object({
  name: z.string().min(1).max(80),
  purpose: z.string().max(300),
  recurring_tasks: z.array(z.object({ name: z.string().min(1).max(120), evidence: z.number().int().min(0).max(100_000) }).strict()).max(8),
  screens_fields: z.array(z.string().min(1).max(200)).max(10),
  patterns: z.array(z.string().min(1).max(200)).max(10),
  exceptions: z.array(z.string().min(1).max(200)).max(8),
  open_questions: z.array(z.string().min(1).max(200)).max(5),
  today: z.array(z.string().min(1).max(160)).max(3),
}).strict()

const KNOWN: Record<string, string> = { 'msedge.exe': 'Edge', 'chrome.exe': 'Chrome', 'excel.exe': 'Excel', 'winword.exe': 'Word', 'outlook.exe': 'Outlook', 'code.exe': 'VS Code', 'explorer.exe': 'File Explorer', 'ms-teams.exe': 'Teams' }
export function appLabel(key: string): string {
  if (key.startsWith('browser:')) return key.slice(8).replace(/^www\./, '')
  return KNOWN[key.toLowerCase()] ?? key.replace(/\.exe$/i, '').replace(/^./, (c) => c.toUpperCase())
}

const top = <T>(counts: Map<T, number>, n: number) => [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
const bump = <T>(counts: Map<T, number>, key: T) => counts.set(key, (counts.get(key) ?? 0) + 1)

/** A compact, value-free interaction dataset from masked ambient events. */
export function summarizeHabits(entries: MemoryEntry[], previous?: AppProfile['habits']): NonNullable<AppProfile['habits']> {
  const actions = new Map((previous?.frequent_actions ?? []).map((item) => [item.label, item.count]))
  const fields = new Map((previous?.frequent_fields ?? []).map((item) => [item.label, item.count]))
  const sequences = new Map((previous?.action_sequences ?? []).map((item) => [`${item.from}\u0000${item.to}`, item.count]))
  let last: { label: string; t: number } | null = null
  for (const entry of entries) {
    const label = entry.type === 'click' && entry.target ? `Click ${entry.target.slice(0, 120)}`
      : entry.type === 'commit' && entry.field ? `Enter ${entry.field.slice(0, 120)}` : ''
    if (!label) continue
    if (entry.type === 'click') bump(actions, label)
    else if (entry.type === 'commit') bump(fields, entry.field.slice(0, 120))
    if (last && entry.t - last.t >= 0 && entry.t - last.t <= 60 && last.label !== label) bump(sequences, `${last.label}\u0000${label}`)
    last = { label, t: entry.t }
  }
  return {
    frequent_actions: top(actions, 8).map(([label, count]) => ({ label, count })),
    frequent_fields: top(fields, 8).map(([label, count]) => ({ label, count })),
    action_sequences: top(sequences, 8).map(([pair, count]) => { const [from, to] = pair.split('\u0000'); return { from, to, count } }),
  }
}

/** The log as compact lines: window titles, commits and clicks first (PLAN §5.2), then descriptions and text. */
export function compressLog(entries: MemoryEntry[], budget = LOG_BUDGET): string {
  const titles = new Map<string, number>(), clicks = new Map<string, number>()
  const commits: string[] = [], descriptions: string[] = [], highlights: string[] = [], text = new Set<string>()
  for (const e of entries) {
    if (e.type === 'context') bump(titles, e.title)
    else if (e.type === 'click') bump(clicks, `${e.target} (${e.control_type})`)
    else if (e.type === 'commit') commits.push(`${e.field}: ${e.old || '(empty)'} → ${e.new || '(empty)'}`)
    else if (e.type === 'description') descriptions.push(e.text)
    else if (e.type === 'highlight') highlights.push(`${e.text} (in ${e.title})`)
    else if (e.type === 'text') for (const line of e.lines) text.add(line)
  }
  const sections = [
    ['Window titles', top(titles, 40).map(([t, n]) => `${t} ×${n}`)],
    ['Field entries', commits.slice(-150)],
    ['Highlighted text', highlights.slice(-80)],
    ['Clicked', top(clicks, 60).map(([t, n]) => `${t} ×${n}`)],
    ['Screen descriptions', descriptions.slice(-60)],
    ['Visible text', [...text].slice(-400)],
  ] as const
  let out = ''
  for (const [name, lines] of sections) {
    if (!lines.length) continue
    const block = `## ${name}\n${lines.join('\n')}\n`
    if (out.length + block.length > budget) { out += block.slice(0, Math.max(0, budget - out.length)); break }
    out += block
  }
  return out
}

/** No model: what the log itself shows. */
export function localProfile(key: string, entries: MemoryEntry[], existing: AppProfile | null): z.infer<typeof profileSchema> {
  const titles = new Map<string, number>(), tasks = new Map<string, number>()
  const today = new Date().toISOString().slice(0, 10)
  let commitsToday = 0, clicksToday = 0
  const screensToday = new Set<string>()
  for (const e of entries) {
    const isToday = new Date(e.t * 1000).toISOString().slice(0, 10) === today
    if (e.type === 'context') { bump(titles, e.title); if (isToday) screensToday.add(e.title) }
    if (e.type === 'commit') { bump(tasks, `Enter ${e.field}`); if (isToday) commitsToday++ }
    if (e.type === 'click' && e.target && !/document/i.test(e.control_type)) { bump(tasks, `Click ${e.target}`); if (isToday) clicksToday++ }
  }
  const merged = new Map((existing?.recurring_tasks ?? []).map((task) => [task.name, task.evidence] as const))
  for (const [name, n] of tasks) merged.set(name, (merged.get(name) ?? 0) + n)
  const habits = summarizeHabits(entries, existing?.habits)
  const observed = habits.action_sequences.find((item) => item.count >= 2)
  const question = observed ? `Why do you usually ${observed.to.toLowerCase()} after ${observed.from.toLowerCase()} in ${appLabel(key)}?`
    : habits.frequent_fields[0] ? `What should a new hire check before entering ${habits.frequent_fields[0].label} in ${appLabel(key)}?` : ''
  return {
    name: existing?.name || appLabel(key),
    purpose: existing?.purpose ?? '',
    recurring_tasks: top(merged, 6).map(([name, evidence]) => ({ name: name.slice(0, 120), evidence })),
    screens_fields: [...new Set([...top(titles, 6).map(([t]) => t.slice(0, 200)), ...(existing?.screens_fields ?? [])])].slice(0, 10),
    patterns: [...new Set([...(existing?.patterns ?? []), ...habits.action_sequences.filter((item) => item.count >= 2).slice(0, 3).map((item) => `${item.from} → ${item.to} (${item.count} times)`)])].slice(0, 10),
    exceptions: existing?.exceptions ?? [],
    open_questions: [...new Set([...(existing?.open_questions ?? []), ...(question ? [question] : [])])].slice(0, 5),
    today: [`${commitsToday} field entries`, `${clicksToday} clicks`, `${screensToday.size} screens`],
  }
}

export function createRollup(ctx: AppContext, dependencies: { model?: ReturnType<typeof getLlm>; prompt?: string } = {}) {
  const store = getStore(ctx)
  const memory = getMemory(ctx)
  let running: Promise<unknown> = Promise.resolve()
  const busy = new Set<string>()
  const file = (key: string) => ['profiles', `${appDirectory(key)}.json`]
  async function redact(text: string): Promise<string> {
    if (!text) return text
    try { return (await ctx.bus.request('observer:redact', { text })).text } catch { return text } // derived from masked logs
  }
  async function read(key: string): Promise<AppProfile | null> {
    return store.read<AppProfile>(file(key)).catch(() => null)
  }
  async function links(key: string): Promise<{ guides: string[]; workmaps: string[] }> {
    const guides: string[] = []
    for (const name of await store.list(['guides'])) {
      if (!name.endsWith('.json')) continue
      const guide = await store.read<Guide>(['guides', name]).catch(() => null)
      if (guide && (guide.app === key || guide.app_keys?.includes(key))) guides.push(guide.id)
    }
    const workmaps: string[] = []
    for (const name of await store.list(['workmaps'])) {
      if (!name.endsWith('.json')) continue
      const map = await store.read<WorkMap>(['workmaps', name]).catch(() => null)
      if (map && guides.includes(map.guide)) workmaps.push(map.id)
    }
    return { guides, workmaps }
  }
  async function save(profile: AppProfile): Promise<AppProfile> {
    await store.write(file(profile.key), profile)
    ctx.bus.emit('profile:updated', structuredClone(profile))
    return profile
  }

  async function rollup(key: string): Promise<AppProfile> {
    const existing = await read(key)
    const stats = await memory.stats(key)
    const entries = await memory.since(key, existing ? stats?.rollup.t ?? 0 : 0)
    let body: z.infer<typeof profileSchema>
    if (!entries.length && existing) {
      // Nothing new since the last rollup: keep what the profile says, refresh minutes and links.
      const { name, purpose, recurring_tasks, screens_fields, patterns, exceptions, open_questions, today } = existing
      body = { name, purpose, recurring_tasks, screens_fields, patterns, exceptions, open_questions, today }
    } else try {
      body = await (dependencies.model ?? getLlm(ctx)).fast({
        appKeys: [key],
        system: dependencies.prompt ?? await readPrompt('app_profile'),
        input: JSON.stringify({
          key, today: new Date().toISOString().slice(0, 10),
          current_profile: existing ? { ...existing, expert_quotes: existing.expert_quotes.slice(-10) } : null,
          new_log: compressLog(entries),
        }),
        schema: profileSchema,
      })
    } catch {
      body = localProfile(key, entries, existing)
    }
    const answered = new Set((existing?.expert_quotes ?? []).map((q) => q.q.trim().toLowerCase()))
    const clean = async (items: string[]) => Promise.all(items.map(redact))
    const habits = summarizeHabits(entries, existing?.habits)
    const profile: AppProfile = {
      key,
      name: await redact(body.name),
      minutes: Math.round(stats?.minutes ?? existing?.minutes ?? 0),
      last_seen: stats?.last_seen ?? existing?.last_seen ?? new Date().toISOString(),
      purpose: await redact(body.purpose),
      recurring_tasks: await Promise.all(body.recurring_tasks.map(async (task) => ({ name: await redact(task.name), evidence: task.evidence }))),
      screens_fields: await clean(body.screens_fields),
      patterns: await clean(body.patterns),
      exceptions: await clean(body.exceptions),
      open_questions: (await clean(body.open_questions)).filter((q) => !answered.has(q.trim().toLowerCase())),
      expert_quotes: existing?.expert_quotes ?? [],
      today: await clean(body.today),
      ...(await links(key)),
      habits: {
        frequent_actions: await Promise.all(habits.frequent_actions.map(async (item) => ({ label: await redact(item.label), count: item.count }))),
        frequent_fields: await Promise.all(habits.frequent_fields.map(async (item) => ({ label: await redact(item.label), count: item.count }))),
        action_sequences: await Promise.all(habits.action_sequences.map(async (item) => ({ from: await redact(item.from), to: await redact(item.to), count: item.count }))),
      },
    }
    memory.markRolledUp(key, Date.now() / 1000)
    return save(profile)
  }

  /** One rollup at a time; a second request for the same app while it runs is ignored. */
  function request(key: string): Promise<AppProfile | null> {
    if (busy.has(key)) return Promise.resolve(null)
    busy.add(key)
    const task = running.catch(() => undefined).then(() => rollup(key)).finally(() => busy.delete(key))
    running = task
    return task
  }

  async function due(): Promise<string[]> {
    return (await memory.allStats())
      .filter((s) => s.minutes - s.rollup.minutes >= ROLLUP_MINUTES || s.bytes - s.rollup.bytes >= ROLLUP_BYTES)
      .map((s) => s.key)
  }

  async function list(): Promise<AppProfile[]> {
    const out: AppProfile[] = []
    for (const name of await store.list(['profiles'])) {
      if (!name.endsWith('.json')) continue
      const profile = await store.read<AppProfile>(['profiles', name]).catch(() => null)
      if (!profile) continue
      const stats = await memory.stats(profile.key)
      if (stats) { profile.minutes = Math.round(stats.minutes); profile.last_seen = stats.last_seen }
      out.push(profile)
    }
    return out.sort((a, b) => b.last_seen.localeCompare(a.last_seen))
  }

  async function answer(key: string, question: string, text: string): Promise<AppProfile> {
    const profile = await read(key)
    if (!profile) throw new Error('No profile for this app yet.')
    const q = await redact(question.trim())
    const a = (await ctx.bus.request('observer:redact', { text: text.trim() })).text // never store an unmasked answer
    profile.expert_quotes = [...profile.expert_quotes, { q, a, t: new Date().toISOString() }].slice(-50)
    profile.open_questions = profile.open_questions.filter((item) => item.trim().toLowerCase() !== question.trim().toLowerCase() && item.trim().toLowerCase() !== q.trim().toLowerCase())
    return save(profile)
  }

  return { rollup: request, due, list, read, answer, drain: () => running.catch(() => undefined) }
}

const rollups = new WeakMap<AppContext, ReturnType<typeof createRollup>>()
export function getRollup(ctx: AppContext): ReturnType<typeof createRollup> {
  let r = rollups.get(ctx)
  if (!r) { r = createRollup(ctx); rollups.set(ctx, r) }
  return r
}

export const init: ServiceInit = (ctx) => {
  const rollup = getRollup(ctx)
  setInterval(() => {
    void rollup.due().then(async (keys) => { if (keys[0]) await rollup.rollup(keys[0]) }).catch((error) => console.error('[rollup]', error))
  }, CHECK_EVERY_MS).unref?.()
  const keySchema = z.object({ key: z.string().min(1).max(300) }).strict()
  ctx.handle('profiles:list', () => rollup.list())
  ctx.handle('profile:refresh', async (payload) => {
    const { key } = keySchema.parse(payload)
    return (await rollup.rollup(key)) ?? rollup.read(key)
  })
  ctx.handle('profile:answer', (payload) => {
    const { key, question, answer } = z.object({ key: z.string().min(1).max(300), question: z.string().min(1).max(300), answer: z.string().min(1).max(2000) }).strict().parse(payload)
    return rollup.answer(key, question, answer)
  })
}
