// Privacy page backend (PLAN §6.3): read and write privacy.json (atomically, then the sidecar reloads
// it), per-app capture mode (uia / vision, written by the sidecar), and timed pauses (15 min, 1 h,
// until tomorrow) built on the off-the-record switch.
import { z } from 'zod'
import type { AppContext, AppModes, PrivacyConfig, ServiceInit } from '@shared/contracts'
import { getStore } from './store'

const DEFAULTS: PrivacyConfig = {
  mask: { passwords: true, secrets: true, cards: true, ssn: true, iban: true, email: false, phone: false },
  skip: { banking: true, password_managers: true, private_windows: true },
  blocked_apps: [], blocked_domains: [], allow_only: null,
  raw_retention_days: 7, local_only_apps: [], ambient_screenshots: true,
}

const list = z.array(z.string().trim().min(1).max(200)).max(500).transform((items) => [...new Set(items.map((i) => i.toLowerCase()))])
export const privacySchema = z.object({
  mask: z.object({ passwords: z.boolean(), secrets: z.boolean(), cards: z.boolean(), ssn: z.boolean(), iban: z.boolean(), email: z.boolean(), phone: z.boolean() }).strict(),
  skip: z.object({ banking: z.boolean(), password_managers: z.boolean(), private_windows: z.boolean() }).strict(),
  blocked_apps: list,
  blocked_domains: list,
  allow_only: list.nullable(),
  raw_retention_days: z.number().int().min(1).max(365),
  local_only_apps: list,
  ambient_screenshots: z.boolean(),
}).strict()

/** Whatever is on disk, merged over the defaults (the sidecar does the same). */
export function normalizePrivacy(raw: unknown): PrivacyConfig {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Partial<PrivacyConfig>
  const merged = { ...DEFAULTS, ...value, mask: { ...DEFAULTS.mask, ...(value.mask ?? {}) }, skip: { ...DEFAULTS.skip, ...(value.skip ?? {}) } }
  const parsed = privacySchema.safeParse(merged)
  return parsed.success ? parsed.data : structuredClone(DEFAULTS)
}

export function createPrivacy(ctx: AppContext, options: { offRecord?: () => Promise<boolean>; toggleOffRecord?: () => Promise<unknown> } = {}) {
  const store = getStore(ctx)
  let resumeTimer: ReturnType<typeof setTimeout> | null = null
  let pausedUntil: number | null = null

  async function get(): Promise<{ privacy: PrivacyConfig; app_modes: AppModes; paused_until: number | null }> {
    const privacy = normalizePrivacy(await store.read(['config', 'privacy.json']).catch(() => null))
    const modes = await store.read<AppModes>(['config', 'app_modes.json']).catch(() => null)
    return { privacy, app_modes: modes && typeof modes === 'object' ? modes : {}, paused_until: pausedUntil }
  }
  async function set(payload: unknown) {
    const next = privacySchema.parse(payload)
    await store.write(['config', 'privacy.json'], next) // atomic: temp file + rename
    await ctx.bus.request('observer:reloadConfig', {}).catch(() => ({ ok: false }))
    return get()
  }
  async function setCapture(key: string, value: 'uia' | 'vision') {
    const r = await ctx.bus.request('observer:setCapture', { key, value }).catch(() => ({ ok: false }))
    if (!r.ok) throw new Error('The observer could not change the capture mode.')
    return get()
  }
  async function pause(minutes: number | 'tomorrow') {
    if (!options.offRecord || !options.toggleOffRecord) throw new Error('Pausing needs the session service.')
    const until = minutes === 'tomorrow' ? new Date(new Date().setHours(24, 0, 0, 0)).getTime() : Date.now() + minutes * 60_000
    if (!(await options.offRecord())) await options.toggleOffRecord()
    if (resumeTimer) clearTimeout(resumeTimer)
    pausedUntil = until
    resumeTimer = setTimeout(() => { void resume() }, Math.min(until - Date.now(), 2 ** 31 - 1))
    return get()
  }
  async function resume() {
    if (resumeTimer) clearTimeout(resumeTimer)
    resumeTimer = null; pausedUntil = null
    if (options.offRecord && options.toggleOffRecord && (await options.offRecord())) await options.toggleOffRecord()
    return get()
  }
  return { get, set, setCapture, pause, resume }
}

export const init: ServiceInit = async (ctx) => {
  const session = await import('./session') // needs Electron
  const privacy = createPrivacy(ctx, {
    offRecord: async () => session.isOffRecord(),
    toggleOffRecord: () => session.toggleOffRecord(),
  })
  ctx.handle('privacy:get', () => privacy.get())
  ctx.handle('privacy:set', (payload: unknown) => privacy.set(payload))
  ctx.handle('privacy:setCapture', (payload: unknown) => {
    const { key, value } = z.object({ key: z.string().min(1).max(300), value: z.enum(['uia', 'vision']) }).strict().parse(payload)
    return privacy.setCapture(key, value)
  })
  ctx.handle('privacy:pause', (payload: unknown) => {
    const { minutes } = z.object({ minutes: z.union([z.number().int().min(1).max(24 * 60), z.literal('tomorrow')]) }).strict().parse(payload)
    return privacy.pause(minutes)
  })
  ctx.handle('privacy:resume', () => privacy.resume())
}
