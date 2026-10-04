// Mastery report (PLAN §5.6 step 6): at the end of a lesson, each Work Map step is listed as done
// alone, done after a hint, caught by a guardrail, or not reached, with what to practise next.
// Outcomes come from the tutor's mark_step tool and from guardrail violations.
import { z } from 'zod'
import type { AppContext, MasteryReport, ServiceInit, WorkMap } from '@shared/contracts'
import { getStore } from './store'
import { getLlm, readPrompt } from './llm'
import { stepIndex } from './workmap'

type Outcome = MasteryReport['steps'][number]['outcome']
const RANK: Record<Outcome, number> = { not_reached: 0, alone: 1, hint: 2, caught: 3 }
const idSchema = z.string().min(1).max(160).regex(/^[a-zA-Z0-9_-]+$/)
export const summarySchema = z.object({ summary: z.string().min(1).max(600), practise_next: z.array(z.string().min(1).max(200)).max(5) }).strict()

export function buildReport(session: string, map: WorkMap, marks: Map<string, Outcome>, caught: Map<string, string>, t: number): MasteryReport {
  const steps = map.steps.map((step) => {
    const outcome: Outcome = caught.has(step.id) ? 'caught' : marks.get(step.id) ?? 'not_reached'
    const note = outcome === 'caught' ? caught.get(step.id)! : outcome === 'hint' ? 'Needed a hint.' : outcome === 'alone' ? 'Done without help.' : 'Not part of this lesson.'
    return { step_id: step.id, title: step.title, outcome, note }
  })
  const count = (o: Outcome) => steps.filter((s) => s.outcome === o).length
  const reached = steps.length - count('not_reached')
  const summary = `${count('alone')} of ${reached} steps done alone, ${count('hint')} after a hint, ${count('caught')} caught by a guardrail.`
  const practise_next = [
    ...steps.filter((s) => s.outcome === 'caught').map((s) => {
      const rail = map.steps.find((m) => m.id === s.step_id)?.guardrails[0]
      return rail ? `${s.title}: ${rail.rule}` : s.title
    }),
    ...steps.filter((s) => s.outcome === 'hint').map((s) => s.title),
  ].slice(0, 5)
  return { session, workmap_id: map.id, t, steps, summary, practise_next }
}

export function createMastery(ctx: AppContext, dependencies: { model?: ReturnType<typeof getLlm>; prompt?: string; open?: (path: string) => void } = {}) {
  const store = getStore(ctx)
  let lesson: { session: string; workmap_id: string; marks: Map<string, Outcome>; caught: Map<string, string> } | null = null
  const pending = new Set<Promise<unknown>>()
  const track = (task: Promise<unknown>) => {
    pending.add(task)
    void task.catch((error) => console.error('[mastery]', error)).finally(() => pending.delete(task))
  }

  async function finish(current: NonNullable<typeof lesson>): Promise<MasteryReport | null> {
    const map = await ctx.bus.request('brain:workmap', { id: current.workmap_id }).catch(() => null)
    if (!map) return null
    const report = buildReport(current.session, map, current.marks, current.caught, Date.now() / 1000)
    if (report.steps.every((s) => s.outcome === 'not_reached')) return null // nothing happened in this lesson
    try {
      const guide = map.guide ? await ctx.bus.request('brain:guide', { id: map.guide }).catch(() => null) : null
      const written = await (dependencies.model ?? getLlm(ctx)).smart({
        appKeys: guide?.app_keys?.length ? guide.app_keys : guide ? [guide.app] : [],
        system: dependencies.prompt ?? await readPrompt('mastery_report'),
        input: JSON.stringify({ role: map.role, expert: 'the expert', steps: report.steps.map((s) => ({ ...s, guardrails: map.steps.find((m) => m.id === s.step_id)?.guardrails.map((g) => g.rule) ?? [] })) }),
        schema: summarySchema,
      })
      const redact = async (text: string) => { try { return (await ctx.bus.request('observer:redact', { text })).text } catch { return text } }
      report.summary = await redact(written.summary)
      report.practise_next = await Promise.all(written.practise_next.map(redact))
    } catch { /* the counted summary stays */ }
    await store.write(['mastery', `${idSchema.parse(current.session)}.json`], report)
    ctx.broadcast('mastery:updated', report)
    dependencies.open?.(`lessons?session=${encodeURIComponent(current.session)}`)
    return report
  }

  async function list(): Promise<MasteryReport[]> {
    const out: MasteryReport[] = []
    for (const file of await store.list(['mastery'])) if (file.endsWith('.json')) { const r = await store.read<MasteryReport>(['mastery', file]).catch(() => null); if (r) out.push(r) }
    return out.sort((a, b) => b.t - a.t)
  }

  ctx.bus.on('session:started', (event) => {
    lesson = event.kind === 'tutor' && event.workmap_id ? { session: event.id, workmap_id: event.workmap_id, marks: new Map(), caught: new Map() } : null
  })
  ctx.bus.on('tutor:mark_step', (event) => {
    const current = lesson
    if (!current || event.session !== current.session) return
    track((async () => {
      const map = await ctx.bus.request('brain:workmap', { id: current.workmap_id }).catch(() => null)
      const index = map ? stepIndex(map, event.step_id) : -1
      if (!map || index < 0) return
      const id = map.steps[index].id
      const previous = current.marks.get(id)
      if (!previous || RANK[event.outcome] >= RANK[previous]) current.marks.set(id, event.outcome) // a hint isn't undone by a later "alone"
    })())
  })
  ctx.bus.on('tutor:violation', (event) => {
    if (lesson && event.session === lesson.session) lesson.caught.set(event.step_id, event.why)
  })
  ctx.bus.on('session:stopped', (event) => {
    const current = lesson
    if (!current || current.session !== event.id) return
    lesson = null
    track(Promise.allSettled([...pending]).then(() => finish(current)))
  })
  ctx.handle('mastery:list', () => list())
  ctx.handle('mastery:get', async (payload) => store.read<MasteryReport>(['mastery', `${idSchema.parse(z.object({ session: z.string() }).strict().parse(payload).session)}.json`]))
  return { list, drain: async () => { while (pending.size) await Promise.allSettled([...pending]) } }
}

export const init: ServiceInit = async (ctx) => {
  const { openDashboard } = await import('./windows') // needs Electron; the logic above is tested without it
  createMastery(ctx, { open: openDashboard })
}
