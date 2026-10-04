// Guardrail checker (PLAN §5.6): during a lesson, every field commit and every click on a save-like
// button (Post, Save, Submit, Confirm) is checked against the Work Map's guardrails, so the tutor can
// step in before anything is saved. The form's current values come from the sidecar's tree (masked).
// MODEL_FAST decides; without it, a conservative local rule catches a value the expert corrected away
// from, when the screen shows what that step was about.
import { z } from 'zod'
import type { AppContext, Guide, Quote, Rect, ServiceInit, SidecarEvent, UiControl, Violation, WorkMap, WorkMapStep } from '@shared/contracts'
import { getLlm, readPrompt } from './llm'

const SAVE_LIKE = /\b(post|save|submit|confirm|book|approve|send)\b/i
const COOLDOWN_S = 8
const TEXT_LINES = 60

export const verdictSchema = z.object({
  violation: z.boolean(),
  step_id: z.string().max(40).nullable(),
  guardrail_id: z.string().max(40).nullable(),
  field: z.string().max(160).nullable(),
  why: z.string().max(300),
}).strict()

export interface Trigger { kind: 'commit' | 'save'; t: number; field?: string; value?: string; rect?: Rect | null; target?: string }
export interface Candidate { step: WorkMapStep; guardrail_id: string; why: string; field: string; quote: Quote }

const normal = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const STOP = new Set(['always', 'never', 'invoice', 'invoices', 'because', 'should', 'would', 'their', 'there', 'which', 'without', 'before', 'after', 'about', 'every', 'other', 'number', 'field', 'value', 'center', 'centre'])

/** Words that say what a step is about ("equipment", "december"), not field names or numbers. */
export function topicWords(step: WorkMapStep, fields: string[]): string[] {
  const fieldWords = new Set(fields.flatMap((f) => normal(f).split(' ')))
  const text = [step.title, step.decision, step.reason.text, ...step.guardrails.flatMap((g) => [g.rule, g.quote])].join(' ')
  return [...new Set(normal(text).split(' ').filter((w) => w.length >= 5 && !/\d/.test(w) && !STOP.has(w) && !fieldWords.has(w)))]
}

/** Thresholds like "over €5,000", "above 5000", "> 5,000" in a step's rules and quotes. */
export function thresholds(step: WorkMapStep): number[] {
  const text = [step.decision, step.reason.text, ...step.guardrails.flatMap((g) => [g.rule, g.quote])].join(' ')
  const out: number[] = []
  for (const m of text.matchAll(/(?:over|above|more than|exceeds?|>)\s*(?:€|eur|euros?|\$)?\s*(\d{1,3}(?:[.,\s]\d{3})+|\d+)(\s*k\b)?/gi)) {
    const n = Number(m[1].replace(/[.,\s]/g, '')) * (m[2] ? 1000 : 1)
    if (n > 0 && !out.includes(n)) out.push(n)
  }
  return out
}

/** Money on screen: "7200.00", "€7,200", "7,200.00 EUR". Bare numbers (cost centers, invoice ids) are not amounts. */
export function amounts(texts: string[]): number[] {
  const out: number[] = []
  const money = /(?:(?:€|eur\b|\$)\s*(\d+(?:,\d{3})*(?:\.\d{1,2})?))|(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?)|(\d+\.\d{2})\b/gi
  for (const text of texts) for (const m of text.matchAll(money)) {
    const n = Number((m[1] ?? m[2] ?? m[3]).replace(/,/g, ''))
    if (Number.isFinite(n)) out.push(n)
  }
  return out
}

/**
 * Local rule (no model): the new hire leaves or enters the value the expert changed away from, in the same
 * field, while the screen shows that step's topic (and any amount threshold it states is exceeded).
 */
export function localCheck(map: WorkMap, guide: Guide, form: UiControl[], screenText: string[], trigger: Trigger): Candidate | null {
  const valueOf = (field: string): string | undefined => {
    if (trigger.field && normal(trigger.field) === normal(field)) return trigger.value
    return form.find((c) => /edit|combobox|spinner/i.test(c.control_type) && normal(c.name) === normal(field))?.value
  }
  const screen = normal([...screenText, ...form.map((c) => `${c.name} ${c.value ?? ''}`)].join(' '))
  const onScreenAmounts = amounts([...screenText, ...form.map((c) => c.value ?? '')])
  for (const step of map.steps) {
    const enters = step.guide_steps.map((id) => guide.steps.find((s) => s.id === id)).filter((s) => s?.kind === 'enter' && s.old_value && s.value && s.old_value !== s.value)
    for (const expert of enters) {
      const current = valueOf(expert!.target)
      if (current === undefined || normal(current) !== normal(expert!.old_value!)) continue
      const topics = topicWords(step, guide.steps.map((s) => s.target))
      if (!topics.some((w) => screen.includes(w))) continue
      const limits = thresholds(step)
      if (limits.length && !onScreenAmounts.some((a) => limits.some((l) => a > l))) continue
      const rail = step.guardrails[0]
      return {
        step, guardrail_id: rail?.id ?? '', field: expert!.target,
        why: `${expert!.target} is ${current}, but ${map.expert || 'the expert'} changed it to ${expert!.value} in this situation.`,
        quote: rail ? { text: rail.quote, t: rail.t, source: rail.source } : step.reason,
      }
    }
  }
  return null
}

export function createChecker(ctx: AppContext, dependencies: { model?: ReturnType<typeof getLlm>; prompt?: string } = {}) {
  let lesson: { session: string; map: WorkMap; guide: Guide | null } | null = null
  let key = ''
  let blocked = true
  const lines: string[] = []
  const fired = new Set<string>()
  let lastFired = 0
  let running: Promise<unknown> = Promise.resolve()
  const report = (message: string) => ctx.broadcast('brain:status', { area: 'checker', message })

  async function check(trigger: Trigger): Promise<Violation | null> {
    const current = lesson
    if (!current || blocked) return null
    const form = await ctx.bus.request('observer:tree', { max: 300 }).then((r) => r.controls).catch(() => [] as UiControl[])
    const screenText = lines.slice(-TEXT_LINES)
    let candidate: Candidate | null = null
    try {
      const verdict = await (dependencies.model ?? getLlm(ctx)).fast({
        appKeys: key ? [key] : current.guide?.app_keys ?? [], // empty: the model refuses, the local rule runs
        system: dependencies.prompt ?? await readPrompt('guardrail_checker'),
        input: JSON.stringify({
          trigger,
          form: form.filter((c) => c.value !== undefined || /button/i.test(c.control_type)).slice(0, 80).map((c) => ({ name: c.name, type: c.control_type, value: c.value })),
          screen_text: screenText,
          workmap: current.map.steps.map((s) => ({ id: s.id, title: s.title, decision: s.decision, reason: s.reason.text, guardrails: s.guardrails.map((g) => ({ id: g.id, type: g.type, rule: g.rule, quote: g.quote })) })),
          expert_values: current.guide?.steps.filter((s) => s.kind === 'enter').map((s) => ({ field: s.target, before: s.old_value, after: s.value })) ?? [],
        }),
        schema: verdictSchema,
      })
      if (verdict.violation) {
        const step = current.map.steps.find((s) => s.id === verdict.step_id)
        const rail = step?.guardrails.find((g) => g.id === verdict.guardrail_id) ?? step?.guardrails[0]
        if (step) candidate = { step, guardrail_id: rail?.id ?? '', why: verdict.why, field: verdict.field ?? trigger.field ?? '', quote: rail ? { text: rail.quote, t: rail.t, source: rail.source } : step.reason }
      }
    } catch {
      if (current.guide) candidate = localCheck(current.map, current.guide, form, screenText, trigger)
    }
    if (!candidate || lesson !== current) return null
    const fieldControl = form.find((c) => normal(c.name) === normal(candidate!.field) && /edit|combobox|spinner/i.test(c.control_type))
    const value = fieldControl?.value ?? trigger.value ?? ''
    const id = `${candidate.step.id}|${candidate.guardrail_id}|${normal(candidate.field)}|${value}`
    const t = Date.now() / 1000
    if (fired.has(id) || t - lastFired < COOLDOWN_S) return null
    fired.add(id); lastFired = t
    let why = candidate.why
    try { why = (await ctx.bus.request('observer:redact', { text: why })).text } catch { /* derived from masked input */ }
    const violation: Violation = {
      session: current.session, step_id: candidate.step.id, guardrail_id: candidate.guardrail_id, why, quote: candidate.quote,
      ...(fieldControl ? { rect: fieldControl.rect } : trigger.rect ? { rect: trigger.rect } : {}),
    }
    ctx.bus.emit('tutor:violation', violation)
    return violation
  }

  function enqueue(trigger: Trigger): Promise<Violation | null> {
    const task = running.catch(() => undefined).then(() => check(trigger))
    running = task.catch((error) => { console.error('[checker]', error); report('Guardrail check failed.') })
    return task
  }

  function onEvent(event: SidecarEvent): Promise<Violation | null> | null {
    if (event.type === 'blocked') { blocked = true; return null }
    if (event.type === 'context') { blocked = false; if (event.key !== key) lines.length = 0; key = event.key; return null }
    if (event.type === 'text') { lines.push(...event.delta); if (lines.length > 300) lines.splice(0, lines.length - 300); return null }
    if (!lesson || blocked) return null
    if (event.type === 'commit') return enqueue({ kind: 'commit', t: event.t, field: event.field, value: event.new, rect: event.rect })
    if (event.type === 'click' && event.target && /button/i.test(event.target.control_type) && SAVE_LIKE.test(event.target.name)) {
      return enqueue({ kind: 'save', t: event.t, target: event.target.name })
    }
    return null
  }

  async function start(session: string, workmapId: string | undefined): Promise<void> {
    lesson = null; fired.clear()
    if (!workmapId) return
    const map = await ctx.bus.request('brain:workmap', { id: workmapId }).catch(() => null)
    if (!map) { report('The lesson has no Work Map, so guardrails cannot be checked.'); return }
    const guide = map.guide ? await ctx.bus.request('brain:guide', { id: map.guide }).catch(() => null) : null
    lesson = { session, map, guide }
  }

  ctx.bus.on('session:started', (event) => { if (event.kind === 'tutor') void start(event.id, event.workmap_id); else lesson = null })
  ctx.bus.on('session:stopped', (event) => { if (lesson?.session === event.id) lesson = null })
  ctx.bus.on('observer:event', (event) => { void onEvent(event) })
  return { start, onEvent, drain: () => running.catch(() => undefined), active: () => lesson }
}

export const init: ServiceInit = (ctx) => { createChecker(ctx) }
