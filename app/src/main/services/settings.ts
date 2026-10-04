// User settings from the first-run wizard (PLAN §5.1): the role ({{role}} in every prompt) and the
// expert's name. Stored in %APPDATA%/apprentice/settings.json.
import { z } from 'zod'
import type { AppContext, ServiceInit } from '@shared/contracts'
import { getStore } from './store'

export interface Settings {
  role: string
  expert: string
  /** The first-run wizard has been completed. */
  onboarded: boolean
}

const schema = z.object({
  role: z.string().trim().min(1).max(80),
  expert: z.string().trim().min(1).max(60),
  onboarded: z.boolean(),
})
const patchSchema = schema.partial().strict()

const defaults = (): Settings => ({
  role: process.env.APPRENTICE_ROLE || 'Accounts payable clerk',
  expert: process.env.APPRENTICE_EXPERT || 'Sabine',
  onboarded: false,
})

let current: Settings = defaults()

/** Synchronous: other services read it while building prompts. */
export function getSettings(): Settings {
  return { ...current }
}

export async function loadSettings(ctx: AppContext): Promise<Settings> {
  const saved = await getStore(ctx).read<unknown>(['settings.json']).catch(() => null)
  const parsed = schema.safeParse({ ...defaults(), ...(saved && typeof saved === 'object' ? saved : {}) })
  current = parsed.success ? parsed.data : defaults()
  return getSettings()
}

export async function saveSettings(ctx: AppContext, patch: unknown): Promise<Settings> {
  const next = schema.parse({ ...current, ...patchSchema.parse(patch) })
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
