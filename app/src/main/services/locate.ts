// Pointer target (PLAN §5.6 step 5): "where do I…?" → the best-matching control in the foreground
// window's accessibility tree (physical px, scaling already corrected by the sidecar). If nothing
// matches, MODEL_FAST finds it on an on-demand screenshot and the point is mapped back with ShotMeta.
import { z } from 'zod'
import type { AppContext, Rect, ServiceInit, ShotMeta, UiControl } from '@shared/contracts'
import { getLlm, readPrompt } from './llm'
import { screenshotData, shotStorage } from './describe'

const POINTABLE = /^(edit|button|combobox|checkbox|radiobutton|hyperlink|menuitem|tabitem|listitem|treeitem|splitbutton|dataitem)/i
const MIN_SCORE = 50

export const visionSchema = z.object({ found: z.boolean(), x: z.number().min(0).max(20000), y: z.number().min(0).max(20000), width: z.number().min(0).max(20000).nullable(), height: z.number().min(0).max(20000).nullable() }).strict()

const normal = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

export function score(target: string, control: UiControl): number {
  const t = normal(target), n = normal(control.name)
  if (!t || !n) return 0
  let s = 0
  if (n === t) s = 100
  else if (n.startsWith(t) || t.startsWith(n)) s = 80
  else if (n.includes(t) || t.includes(n)) s = 65
  else {
    const tw = new Set(t.split(' ')), nw = n.split(' ')
    const shared = nw.filter((w) => tw.has(w)).length
    s = shared ? (shared / Math.max(tw.size, nw.length)) * 60 : 0
  }
  if (s && POINTABLE.test(control.control_type)) s += 10
  if (s && normal(control.automation_id) === t) s += 5
  return s
}

/** Best control for a spoken target; fields beat their labels when both match. */
export function bestControl(target: string, controls: UiControl[]): UiControl | null {
  let best: UiControl | null = null
  let top = 0
  for (const control of controls) {
    const s = score(target, control)
    if (s > top) { top = s; best = control }
  }
  return best && top >= MIN_SCORE ? best : null
}

/** Image pixels → screen pixels: screen_px = origin_px + image_px / scale. */
export function toScreen(meta: ShotMeta, x: number, y: number, width: number, height: number): Rect {
  const sx = meta.origin_px[0] + x / meta.scale, sy = meta.origin_px[1] + y / meta.scale
  const w = Math.max(24, width / meta.scale), h = Math.max(16, height / meta.scale)
  return [Math.round(sx - w / 2), Math.round(sy - h / 2), Math.round(sx + w / 2), Math.round(sy + h / 2)]
}

export function createLocator(ctx: AppContext, dependencies: { model?: ReturnType<typeof getLlm>; prompt?: string } = {}) {
  let appKeys: string[] = []
  ctx.bus.on('observer:event', (event) => {
    if (event.type === 'context') appKeys = [event.key, event.app]
    if (event.type === 'blocked') appKeys = []
  })
  async function locate(target: string): Promise<{ rect: Rect; source: 'uia' | 'vision' } | null> {
    const wanted = target.trim().slice(0, 160)
    if (!wanted || !appKeys.length) return null
    const controls = await ctx.bus.request('observer:tree', { max: 300 }).then((r) => r.controls).catch(() => [] as UiControl[])
    const match = bestControl(wanted, controls)
    if (match) return { rect: match.rect, source: 'uia' }
    let shot: { path: string; meta: ShotMeta } | null = null
    try {
      shot = await ctx.bus.request('observer:shot', {})
      const { bytes, media } = await screenshotData(ctx, shot.path)
      const found = await (dependencies.model ?? getLlm(ctx)).fast({
        appKeys, system: dependencies.prompt ?? await readPrompt('locate_vision'),
        input: JSON.stringify({ target: wanted, image_size: shot.meta.size_px.map((v) => Math.round(v * shot!.meta.scale)) }),
        images: [{ media_type: media, data: bytes.toString('base64') }], schema: visionSchema,
      })
      if (!found.found) return null
      return { rect: toScreen(shot.meta, found.x, found.y, found.width ?? 40, found.height ?? 24), source: 'vision' }
    } catch {
      return null
    } finally {
      if (shot) { try { const s = shotStorage(ctx, shot.path); await s.store.remove(s.parts) } catch { /* the sidecar cleans tmp shots */ } }
    }
  }
  ctx.bus.handle('brain:locate', ({ target }) => locate(target))
  return { locate }
}

export const init: ServiceInit = (ctx) => { createLocator(ctx) }
