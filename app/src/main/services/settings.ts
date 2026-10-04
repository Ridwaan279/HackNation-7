// User settings from the first-run onboarding: company, the expert's role and what they are teaching
// (all feed the voice agents' {{role}}). Nothing is pre-filled: each team describes its own work. Stored in %APPDATA%/apprentice/settings.json.
import { z } from 'zod'
import { constants } from 'node:fs'
import { copyFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
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
  tourDone: boolean
  soundEffects: boolean
}

const schema = z.object({
  role: z.string().trim().max(80),
  company: z.string().trim().max(80),
  teaching: z.string().trim().max(120),
  expert: z.string().trim().min(1).max(60),
  onboarded: z.boolean(),
  mode: z.enum(['expert', 'newhire']),
  tourDone: z.boolean(),
  soundEffects: z.boolean(),
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
  tourDone: false,
  soundEffects: true,
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
  const previous = saved && typeof saved === 'object' ? saved as Partial<Settings> : {}
  const parsed = schema.safeParse({ ...defaults(), ...previous, tourDone: previous.tourDone ?? !!previous.onboarded })
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
  ctx.handle('setup:status', async () => {
    const { app } = await import('electron')
    return {
      envPath: join(app.getAppPath(), '.env'),
      openai: !!process.env.OPENAI_API_KEY,
      models: !!process.env.MODEL_FAST && !!process.env.MODEL_SMART,
      elevenlabs: !!process.env.ELEVENLABS_API_KEY,
      soundEffects: !!process.env.ELEVENLABS_API_KEY && !!process.env.ELEVENLABS_SFX_MODEL,
      voiceAgents: !!process.env.VITE_AGENT_INTERVIEWER && !!process.env.VITE_AGENT_DEBRIEF && !!process.env.VITE_AGENT_TUTOR,
      assistant: !!process.env.VITE_AGENT_ASSISTANT || !!process.env.VITE_AGENT_TUTOR,
    }
  })
  ctx.handle('setup:openEnv', async () => {
    const { app, shell } = await import('electron')
    const envPath = join(app.getAppPath(), '.env')
    try { await copyFile(join(app.getAppPath(), '.env.example'), envPath, constants.COPYFILE_EXCL) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    const failure = await shell.openPath(envPath)
    if (failure) {
      const editor = spawn('notepad.exe', [envPath], { detached: true, stdio: 'ignore', windowsHide: true })
      editor.unref()
    }
    return { envPath }
  })
}
