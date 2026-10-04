// User settings from the first-run onboarding: company, the expert's role and what they are teaching
// (all feed the voice agents' {{role}}). Nothing is pre-filled: each team describes its own work. Stored in %APPDATA%/apprentice/settings.json.
import { z } from 'zod'
import type { AppContext, ServiceInit } from '@shared/contracts'
import { getStore } from './store'

export interface Settings {
  role: string
  /** Shown on the Company profile page and given to the agents. */
  company: string
  /** What the expert is teaching, e.g. "How we handle a refund request". */
  teaching: string
  expert: string
  /** The first-run wizard has been completed. */
  onboarded: boolean
  /** Who is using the app: an expert teaching it, or a new hire learning from it. */
  mode: 'expert' | 'newhire'
}

const schema = z.object({
  role: z.string().trim().max(80),
  company: z.string().trim().max(80),
  teaching: z.string().trim().max(120),
  expert: z.string().trim().min(1).max(60),
  onboarded: z.boolean(),
  mode: z.enum(['expert', 'newhire']),
})
const patchSchema = schema.partial().strict()

const defaults = (): Settings => ({
  role: process.env.APPRENTICE_ROLE || '',
  company: '',
  teaching: '',
  // Nobody is called by name in the app or by the voice agents.
  expert: 'the expert',
  onboarded: false,
  mode: 'expert',
})

let current: Settings = defaults()

/** The role as the agents hear it: "Head of support at Northwind", or "expert" before onboarding. */
export function roleForAgents(s: Settings = current): string {
  return `${s.role || 'expert'}${s.company ? ` at ${s.company}` : ''}`
}

/** Synchronous: other services read it while building prompts. */
export function getSettings(): Settings {
  return { ...current }
}

export async function loadSettings(ctx: AppContext): Promise<Settings> {
  const saved = await getStore(ctx).read<unknown>(['settings.json']).catch(() => null)
  const parsed = schema.safeParse({ ...defaults(), ...(saved && typeof saved === 'object' ? saved : {}) })
  current = parsed.success ? { ...parsed.data, expert: 'the expert' } : defaults()
  return getSettings()
}

export async function saveSettings(ctx: AppContext, patch: unknown): Promise<Settings> {
  const next = { ...schema.parse({ ...current, ...patchSchema.parse(patch) }), expert: 'the expert' }
  await getStore(ctx).write(['settings.json'], next)
  current = next
  ctx.broadcast('settings:updated', getSettings())
  return getSettings()
}

export const init: ServiceInit = async (ctx) => {
  await loadSettings(ctx)
  ctx.handle('settings:get', () => getSettings())
  ctx.handle('settings:set', (patch: unknown) => saveSettings(ctx, patch))
}
