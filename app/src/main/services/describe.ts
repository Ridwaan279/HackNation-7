import path from 'node:path'
import { z } from 'zod'
import type { AppContext, ServiceInit } from '@shared/contracts'
import { appDirectory, JsonStore, getStore } from './store'
import { getLlm, readPrompt } from './llm'

export const descriptionSchema = z.object({ screen_moment: z.string().min(1).max(500), target: z.string().max(160).nullable() }).strict()
export type Description = z.infer<typeof descriptionSchema>
export interface DescriptionInput { path: string; appKeys: string[]; target?: string; t: number; ephemeral: boolean }

/** A emits runtime-root-relative paths. Also accepts absolute paths within runtime shots. */
export function shotStorage(ctx: AppContext, filename: string): { store: JsonStore; parts: string[] } {
  const resolved = path.isAbsolute(filename) ? filename : path.resolve(ctx.paths.root, filename)
  const relative = path.relative(ctx.paths.shots, resolved)
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) throw new Error('Screenshot is outside runtime storage')
  const store = new JsonStore(ctx.paths.shots)
  const parts = relative.split(path.sep)
  store.file(...parts)
  return { store, parts }
}

export function imageMedia(bytes: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  throw new Error('Unsupported screenshot format')
}

export async function screenshotData(ctx: AppContext, filename: string): Promise<{ bytes: Buffer; media: ReturnType<typeof imageMedia> }> {
  const { store, parts } = shotStorage(ctx, filename)
  const bytes = await store.readBytes(parts)
  return { bytes, media: imageMedia(bytes) }
}

export function createDescriber(ctx: AppContext, options: {
  model?: ReturnType<typeof getLlm>
  prompt?: string
} = {}) {
  const running = new Map<string, Promise<Description | null>>()
  let outstanding = 0
  async function describe(input: DescriptionInput): Promise<Description | null> {
    const existing = running.get(input.path)
    if (existing) return existing
    // Cleanup is constrained to the same runtime folder as reads, including on failure.
    const { store, parts } = shotStorage(ctx, input.path)
    const task = (async () => {
      const allowed = outstanding < 2
      if (allowed) outstanding++
      try {
        if (!allowed) return null // bounded work; never accumulate an unbounded image queue
        const { bytes, media } = await screenshotData(ctx, input.path)
        const result = await (options.model ?? getLlm(ctx)).fast({
          appKeys: input.appKeys,
          system: options.prompt ?? await readPrompt('step_vision'),
          input: JSON.stringify({ target: input.target ?? null, t: input.t }),
          images: [{ media_type: media, data: bytes.toString('base64') }], schema: descriptionSchema,
        })
        const screen_moment = (await ctx.bus.request('observer:redact', { text: result.screen_moment })).text
        const target = result.target ? (await ctx.bus.request('observer:redact', { text: result.target })).text : null
        if (input.ephemeral) {
          const day = new Date(input.t * 1000).toISOString().slice(0, 10)
          await getStore(ctx).append(['memory', appDirectory(input.appKeys[0]), `${day}.jsonl`], { type: 'description', t: input.t, key: input.appKeys[0], text: screen_moment })
        }
        return { screen_moment, target }
      } finally {
        if (allowed) outstanding--
        if (input.ephemeral) await store.remove(parts)
      }
    })()
    running.set(input.path, task)
    try { return await task } finally { running.delete(input.path) }
  }
  return { describe }
}

const describers = new WeakMap<AppContext, ReturnType<typeof createDescriber>>()
export function getDescriber(ctx: AppContext): ReturnType<typeof createDescriber> {
  let describer = describers.get(ctx)
  if (!describer) { describer = createDescriber(ctx); describers.set(ctx, describer) }
  return describer
}

export const init: ServiceInit = (ctx) => {
  let processName = ''
  let appKey = ''
  let blocked = true
  let mode: 'ambient' | 'teach' | 'quick_guide' | 'tutor' = 'ambient'
  ctx.bus.on('session:started', (event) => { mode = event.kind })
  ctx.bus.on('session:stopped', () => { mode = 'ambient' })
  ctx.bus.on('observer:event', (event) => {
    if (event.type === 'context') { appKey = event.key; processName = event.app; blocked = false }
    if (event.type === 'blocked') blocked = true
    const filename = event.type === 'shot' ? event.path : event.type === 'click' ? event.shot : null
    const ephemeral = (event.type === 'shot' && event.ephemeral) || mode === 'tutor'
    if (!filename || !ephemeral) return
    const remove = async () => { const storage = shotStorage(ctx, filename); await storage.store.remove(storage.parts) }
    // Tutor captures are not kept or written into ambient memory.
    const work = blocked || mode === 'tutor' || event.type !== 'shot' || event.key !== appKey
      ? remove()
      : getDescriber(ctx).describe({ path: filename, appKeys: [event.key, processName], t: event.t, ephemeral: true })
    void work.catch(() => ctx.broadcast('brain:status', { area: 'description', message: 'Screen description unavailable; check capture cleanup and model configuration.' }))
  })
}
