// Work Map (PLAN §5.5): the "why" behind a guide. A draft is built when the expert presses Stop,
// debrief answers and corrections patch it, and the teach-back confirmation finalizes it.
// Every reason and guardrail quote must be the expert's own words (answers or transcript).
import { z } from 'zod'
import type { Answer, AppContext, Guardrail, Guide, GuideStep, Quote, ServiceInit, TranscriptLine, WorkMap, WorkMapStep } from '@shared/contracts'
import { getStore } from './store'
import { getLlm, readPrompt } from './llm'
import { getSettings } from './settings'

const idSchema = z.string().min(1).max(160).regex(/^[a-zA-Z0-9_-]+$/)
const quoteIn = z.object({ text: z.string().max(600), t: z.number() }).strict()
const railIn = z.object({ type: z.enum(['limit', 'exception', 'stop_and_ask']), rule: z.string().min(1).max(300), quote: quoteIn }).strict()
export const draftSchema = z.object({
  steps: z.array(z.object({
    title: z.string().min(1).max(160),
    guide_steps: z.array(z.string().max(160)).max(40),
    decision: z.string().max(400),
    reason: quoteIn.nullable(),
    guardrails: z.array(railIn).max(6),
    judgment_call: z.boolean(),
  }).strict()).min(1).max(12),
  open_questions: z.array(z.string().min(1).max(240)).max(6),
}).strict()
export const correctionSchema = z.object({
  title: z.string().min(1).max(160),
  decision: z.string().max(400),
  reason: quoteIn.nullable(),
  guardrails: z.array(railIn).max(6),
}).strict()

export interface Evidence { text: string; t: number; source: 'live' | 'debrief' }
type SourcedAnswer = Answer & { session?: string }

const clone = <T>(value: T): T => structuredClone(value)
const words = (text: string) => new Set(text.toLowerCase().replace(/[^\p{L}\p{N}€$%.,\s-]/gu, ' ').split(/\s+/).filter((w) => w.length > 2))
const normal = (text: string) => text.toLowerCase().replace(/[\s"“”'‘’]+/g, ' ').trim()
function overlap(a: string, b: string): number {
  const x = words(a), y = words(b)
  if (!x.size || !y.size) return 0
  let shared = 0
  for (const w of x) if (y.has(w)) shared++
  return shared / Math.min(x.size, y.size)
}

/** A quote survives only if it is the expert's own words: contained in an evidence line, or close to one (then the evidence line is used). */
export function verifyQuote(text: string | null | undefined, evidence: Evidence[]): Quote | null {
  const wanted = normal(text ?? '')
  if (wanted.length < 3) return null
  const contained = evidence.find((line) => normal(line.text).includes(wanted))
  if (contained) return { text: text!.trim().replace(/^["“]|["”]$/g, ''), t: contained.t, source: contained.source }
  let best: Evidence | null = null
  let score = 0
  for (const line of evidence) {
    const s = overlap(wanted, line.text)
    if (s > score) { score = s; best = line }
  }
  return best && score >= 0.6 ? { text: best.text, t: best.t, source: best.source } : null
}

function stepIndex(map: WorkMap, ref: string): number {
  const id = ref.trim()
  let index = map.steps.findIndex((step) => step.id === id)
  if (index < 0 && /^\d+$/.test(id)) index = map.steps.findIndex((step) => step.index === Number(id))
  if (index < 0 && /^s\d+$/i.test(id)) index = map.steps.findIndex((step) => step.index === Number(id.slice(1)))
  if (index < 0 && id.length > 3) index = map.steps.findIndex((step) => normal(step.title).includes(normal(id)))
  return index
}

/** The Work Map step that covers a moment of the session (a related event or answer time). */
export function stepForTime(map: WorkMap, guide: Guide | null, t: number | undefined): WorkMapStep | null {
  if (!map.steps.length) return null
  if (t !== undefined && guide) {
    const guideStep = [...guide.steps].filter((step) => step.t <= t + 0.5).sort((a, b) => b.t - a.t)[0]
    const owner = guideStep && map.steps.find((step) => step.guide_steps.includes(guideStep.id))
    if (owner) return owner
  }
  if (t !== undefined) {
    const covering = map.steps.find((step) => t >= step.t_start - 0.5 && t <= step.t_end + 30)
    if (covering) return covering
  }
  return map.steps[map.steps.length - 1]
}

/** Without a time (most debrief answers): the step whose title, decision and rules share the most words. */
export function stepForText(map: WorkMap, text: string): WorkMapStep | null {
  let best: WorkMapStep | null = null
  let score = 0
  for (const step of map.steps) {
    const s = overlap(text, [step.title, step.decision, ...step.guardrails.map((g) => g.rule)].join(' '))
    if (s > score) { score = s; best = step }
  }
  return score >= 0.2 ? best : map.steps[map.steps.length - 1] ?? null
}

const nextRailId = (map: WorkMap) => `g${Math.max(0, ...map.steps.flatMap((s) => s.guardrails.map((g) => Number(g.id.slice(1)) || 0))) + 1}`

function actionable(step: GuideStep): boolean {
  if (step.kind === 'enter' || step.kind === 'select') return true
  return step.kind === 'click' && /hold|approv|post|send|reject|confirm|save|submit|rerout/i.test(step.title)
}

/** Without a model: one Work Map step per meaningful guide step, reasons and guardrails from the expert's answers. */
export function localDraft(guide: Guide, answers: SourcedAnswer[]): z.infer<typeof draftSchema> {
  const picked = guide.steps.filter(actionable)
  const groups = (picked.length ? picked : guide.steps.filter((step) => step.kind !== 'switch')).slice(0, 12)
  const source = groups.length ? groups : guide.steps.slice(0, 1)
  // An answer belongs to the guide step that was current at its related event.
  const covering = (t: number) => [...guide.steps].filter((step) => step.t <= t + 0.5).sort((a, b) => b.t - a.t)[0]
  const answerFor = (step: GuideStep) => answers.find((a) => a.type === 'reason' && a.related_event_t !== undefined && covering(a.related_event_t)?.id === step.id)
  const steps = source.map((step) => {
    const answer = answerFor(step)
    const linked = step.quote ?? (answer ? { text: answer.answer_quote, t: answer.t } : null)
    return {
      title: step.title.slice(0, 160),
      guide_steps: [step.id],
      decision: step.kind === 'enter' ? `${step.target}: ${step.old_value ? `${step.old_value} → ` : ''}${step.value ?? ''}`.slice(0, 400) : step.title.slice(0, 400),
      reason: linked ? { text: linked.text, t: linked.t } : null,
      guardrails: [] as z.infer<typeof railIn>[],
      judgment_call: step.kind === 'enter' && !!step.old_value,
    }
  })
  const open: string[] = []
  for (const step of source) {
    if (open.length >= 4) break
    if (step.kind === 'enter' && !step.quote) open.push(`Why did you set ${step.target} to ${step.value || 'that value'}?`)
  }
  if (!answers.some((answer) => answer.type === 'guardrail')) open.push('When would you stop and ask someone before posting an invoice like this?')
  if (!answers.some((answer) => answer.type === 'exception')) open.push('Which cases are handled differently from what you showed today?')
  return { steps: steps.length ? steps : [{ title: guide.title.slice(0, 160) || 'Workflow', guide_steps: [], decision: '', reason: null, guardrails: [], judgment_call: false }], open_questions: open.slice(0, 6) }
}

export function createWorkmapService(ctx: AppContext, dependencies: {
  model?: ReturnType<typeof getLlm>
  draftPrompt?: string
  correctionPrompt?: string
  /** How long to wait for the stopped session's final guide (ms). */
  guideWaitMs?: number
} = {}) {
  const store = getStore(ctx)
  const maps = new Map<string, WorkMap>()
  const kinds = new Map<string, string>()
  const stoppedAt = new Map<string, number>()
  const pendingAnswers = new Map<string, SourcedAnswer[]>()
  const pending = new Set<Promise<unknown>>()
  let serialized = Promise.resolve<unknown>(undefined)
  const report = (message: string) => ctx.broadcast('brain:status', { area: 'workmap', message })
  const queue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = serialized.catch(() => undefined).then(operation)
    serialized = result
    return result
  }
  const track = (task: Promise<unknown>) => {
    pending.add(task)
    void task.catch((error) => { console.error('[workmap]', error); report('Work Map update failed. Check storage and model configuration.') }).finally(() => pending.delete(task))
  }
  const model = () => dependencies.model ?? getLlm(ctx)
  async function redact(text: string): Promise<string> {
    if (!text) return text
    try { return (await ctx.bus.request('observer:redact', { text })).text } catch { return text } // derived from already-masked input
  }

  async function load(id: string): Promise<WorkMap | null> {
    idSchema.parse(id)
    if (!maps.has(id)) {
      const saved = await store.read<WorkMap>(['workmaps', `${id}.json`])
      if (saved) maps.set(id, saved)
    }
    return maps.get(id) ?? null
  }
  async function list(): Promise<WorkMap[]> {
    for (const file of await store.list(['workmaps'])) if (file.endsWith('.json')) await load(file.slice(0, -5))
    return clone([...maps.values()].sort((a, b) => b.id.localeCompare(a.id)))
  }
  async function publish(map: WorkMap): Promise<void> {
    maps.set(map.id, map)
    const snapshot = clone(map)
    await store.write(['workmaps', `${map.id}.json`], snapshot)
    ctx.bus.emit('workmap:updated', snapshot)
  }
  async function guideOf(map: WorkMap): Promise<Guide | null> {
    if (!map.guide) return null
    return ctx.bus.request('brain:guide', { id: map.guide }).catch(() => null)
  }
  async function evidence(session: string): Promise<Evidence[]> {
    const stop = stoppedAt.get(session) ?? Infinity
    const answers = await store.lines<SourcedAnswer>(['sessions', session, 'answers.jsonl']).catch(() => [])
    const transcript = await store.lines<TranscriptLine>(['sessions', session, 'transcript.jsonl']).catch(() => [])
    return [
      ...answers.filter((a) => a.answer_quote).map((a) => ({ text: a.answer_quote, t: a.t, source: a.source })),
      ...transcript.filter((line) => line.role === 'expert' && line.text.trim()).map((line) => ({ text: line.text, t: line.t, source: (line.t > stop ? 'debrief' : 'live') as Evidence['source'] })),
    ]
  }

  async function waitForGuide(session: string): Promise<Guide | null> {
    const id = `guide-${session}`
    const deadline = Date.now() + (dependencies.guideWaitMs ?? 4000)
    while (Date.now() < deadline) {
      const guide = await ctx.bus.request('brain:guide', { id }).catch(() => null)
      if (guide && !guide.recording) {
        await new Promise((resolve) => setTimeout(resolve, 300)) // let answers still being linked land
        return (await ctx.bus.request('brain:guide', { id }).catch(() => null)) ?? guide
      }
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    return ctx.bus.request('brain:guide', { id }).catch(() => null)
  }

  function build(session: string, guide: Guide, draft: z.infer<typeof draftSchema>, proof: Evidence[]): WorkMap {
    const known = new Map(guide.steps.map((step) => [step.id, step]))
    let rail = 0
    const steps: WorkMapStep[] = draft.steps.map((step, index) => {
      const ids = step.guide_steps.filter((id) => known.has(id))
      const times = ids.map((id) => known.get(id)!.t)
      const reason = verifyQuote(step.reason?.text, proof)
      const guardrails: Guardrail[] = []
      for (const g of step.guardrails) {
        const quote = verifyQuote(g.quote.text, proof)
        if (!quote) continue // never keep a guardrail without the expert's words
        guardrails.push({ id: `g${++rail}`, type: g.type, rule: g.rule, quote: quote.text, t: quote.t, source: quote.source ?? 'live' })
      }
      return {
        id: `s${index + 1}`, index: index + 1, title: step.title, guide_steps: ids,
        t_start: times.length ? Math.min(...times) : 0, t_end: times.length ? Math.max(...times) : 0,
        decision: step.decision, reason: reason ?? { text: '', t: 0 }, guardrails, judgment_call: step.judgment_call,
      }
    })
    const settings = getSettings()
    return {
      id: `wm-${session}`, role: settings.role, expert: settings.expert, status: 'draft', guide: guide.id,
      steps, open_questions: draft.open_questions, teachback: { confirmed: false, corrections: [] },
    }
  }

  async function redactMap(map: WorkMap): Promise<WorkMap> {
    for (const step of map.steps) {
      step.title = await redact(step.title)
      step.decision = await redact(step.decision)
      for (const g of step.guardrails) g.rule = await redact(g.rule)
    }
    map.open_questions = await Promise.all(map.open_questions.map(redact))
    return map
  }

  async function draft(session: string): Promise<WorkMap | null> {
    const guide = await waitForGuide(session)
    if (!guide || !guide.steps.length) { report('No captured steps, so there is no Work Map to draft.'); return null }
    const answers = await store.lines<SourcedAnswer>(['sessions', session, 'answers.jsonl']).catch(() => [])
    const transcript = await store.lines<TranscriptLine>(['sessions', session, 'transcript.jsonl']).catch(() => [])
    const proof = await evidence(session)
    let result: z.infer<typeof draftSchema>
    try {
      const settings = getSettings()
      result = await model().smart({
        appKeys: guide.app_keys?.length ? guide.app_keys : [guide.app],
        system: dependencies.draftPrompt ?? await readPrompt('workmap_draft'),
        input: JSON.stringify({
          role: settings.role, expert: settings.expert, guide_title: guide.title,
          guide_steps: guide.steps.map((s) => ({ id: s.id, n: s.n, t: s.t, kind: s.kind, title: s.title, target: s.target, value: s.value, old_value: s.old_value, screen_moment: s.screen_moment, quote: s.quote?.text })),
          answers: answers.map((a) => ({ t: a.t, question: a.question, answer_quote: a.answer_quote, type: a.type, related_event_t: a.related_event_t })),
          transcript: transcript.filter((line) => line.role !== 'nudge').slice(-120).map((line) => ({ t: line.t, role: line.role, text: line.text.slice(0, 500) })),
        }).slice(0, 60_000),
        schema: draftSchema, maxTokens: 4096,
      })
    } catch {
      report('Drafted the Work Map locally because the model is unavailable.')
      result = localDraft(guide, answers)
    }
    const map = await redactMap(build(session, guide, result, proof))
    for (const answer of answers.filter((a) => a.source === 'debrief')) integrate(map, guide, answer, proof)
    for (const answer of pendingAnswers.get(session) ?? []) integrate(map, guide, answer, proof)
    pendingAnswers.delete(session)
    await publish(map)
    return map
  }

  /** A debrief answer closes the matching open question and adds its reason or guardrail to the step it is about. */
  function integrate(map: WorkMap, guide: Guide | null, answer: SourcedAnswer, proof: Evidence[]): boolean {
    let changed = false
    if (answer.question) {
      let best = -1, score = 0
      map.open_questions.forEach((question, index) => { const s = overlap(question, answer.question); if (s > score) { score = s; best = index } })
      if (best >= 0 && score >= 0.5) { map.open_questions.splice(best, 1); changed = true }
    }
    const quote = verifyQuote(answer.answer_quote, [...proof, { text: answer.answer_quote, t: answer.t, source: answer.source }])
    if (!quote) return changed
    const step = answer.related_event_t !== undefined
      ? stepForTime(map, guide, answer.related_event_t)
      : stepForText(map, `${answer.question} ${answer.answer_quote}`)
    if (!step) return changed
    if (answer.type === 'reason') {
      if (!step.reason.text) { step.reason = quote; changed = true }
    } else if (!step.guardrails.some((g) => normal(g.quote) === normal(quote.text))) {
      step.guardrails.push({ id: nextRailId(map), type: answer.type === 'exception' ? 'exception' : 'limit', rule: answer.question ? `${answer.question}`.slice(0, 300) : quote.text.slice(0, 300), quote: quote.text, t: quote.t, source: quote.source ?? answer.source })
      changed = true
    }
    return changed
  }

  async function mapForSession(session: string): Promise<WorkMap | null> {
    return load(`wm-${idSchema.parse(session)}`).catch(() => null)
  }

  async function correct(session: string, stepRef: string, correction: string): Promise<void> {
    const map = await mapForSession(session)
    if (!map || map.status === 'confirmed') return
    const quote = await redact(correction)
    const index = stepIndex(map, stepRef)
    map.teachback.corrections.push({ step_id: index >= 0 ? map.steps[index].id : stepRef.slice(0, 40), quote })
    if (index >= 0) {
      const step = map.steps[index]
      const t = Date.now() / 1000
      const proof: Evidence[] = [{ text: quote, t, source: 'debrief' }, ...(await evidence(session))]
      const guide = await guideOf(map)
      try {
        if (!guide) throw new Error('guide unavailable') // the guide's app keys decide the local-only policy
        const patch = await model().fast({
          appKeys: guide.app_keys?.length ? guide.app_keys : [guide.app],
          system: dependencies.correctionPrompt ?? await readPrompt('workmap_correction'),
          input: JSON.stringify({ step, correction: { text: quote, t } }),
          schema: correctionSchema,
        })
        step.title = await redact(patch.title)
        step.decision = await redact(patch.decision)
        step.reason = verifyQuote(patch.reason?.text, proof) ?? step.reason
        const rails: Guardrail[] = []
        for (const g of patch.guardrails) {
          const q = verifyQuote(g.quote.text, proof)
          if (!q) continue
          const id = step.guardrails.find((old) => normal(old.rule) === normal(g.rule))?.id ?? nextRailId({ ...map, steps: [...map.steps, { ...step, guardrails: rails }] })
          rails.push({ id, type: g.type, rule: await redact(g.rule), quote: q.text, t: q.t, source: q.source ?? 'debrief' })
        }
        step.guardrails = rails
      } catch {
        // No model: the correction becomes the step's reason, in the expert's words.
        step.reason = { text: quote, t, source: 'debrief' }
      }
    }
    await publish(map)
  }

  async function confirm(session: string, t: number): Promise<void> {
    const map = await mapForSession(session)
    if (!map) return
    map.status = 'confirmed'
    map.teachback = { ...map.teachback, confirmed: true, t }
    await publish(map)
  }

  ctx.bus.on('session:started', (event) => { kinds.set(event.id, event.kind) })
  ctx.bus.on('session:stopped', (event) => {
    stoppedAt.set(event.id, Date.now() / 1000)
    if (kinds.get(event.id) !== 'teach') return
    track(queue(() => draft(event.id)))
  })
  ctx.bus.on('transcript:line', (line) => {
    if (!idSchema.safeParse(line.session).success) return
    const { session, ...rest } = line
    track(store.append(['sessions', session, 'transcript.jsonl'], rest))
  })
  ctx.bus.on('agent:answer', (answer) => {
    if (answer.source !== 'debrief') return
    track(queue(async () => {
      const map = await mapForSession(answer.session)
      if (!map) { pendingAnswers.set(answer.session, [...(pendingAnswers.get(answer.session) ?? []), answer]); return }
      if (integrate(map, await guideOf(map), answer, await evidence(answer.session))) await publish(map)
    }))
  })
  ctx.bus.on('agent:correction', (event) => { track(queue(() => correct(event.session, event.step_id, event.correction_quote))) })
  ctx.bus.on('agent:teachback_confirmed', (event) => { track(queue(() => confirm(event.session, event.t))) })

  ctx.bus.on('data:cleared', (event) => { if (event.scope === 'all') maps.clear() })

  ctx.bus.handle('brain:workmap', async ({ id }) => clone(await load(id)))
  ctx.bus.handle('brain:stepsFor', async ({ workmap_id, step_id }) => {
    const map = await load(workmap_id)
    if (!map) return []
    const index = stepIndex(map, step_id)
    if (index < 0) return []
    const guide = await guideOf(map)
    if (!guide) return []
    const ids = map.steps[index].guide_steps
    return clone(ids.map((id) => guide.steps.find((step) => step.id === id)).filter((step): step is GuideStep => !!step && !step.screenshot_hidden))
  })
  ctx.handle('workmaps:list', () => list())
  ctx.handle('workmap:get', async (payload) => clone(await load(z.object({ id: idSchema }).strict().parse(payload).id)))

  return { list, load, draft, drain: async () => { while (pending.size) await Promise.allSettled([...pending]); await serialized.catch(() => undefined) } }
}

export const init: ServiceInit = (ctx) => { createWorkmapService(ctx) }
