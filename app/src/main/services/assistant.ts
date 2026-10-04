// On-demand help from the dashboard. Questions are masked before they leave the renderer.
// Guide and Work Map context has already crossed the observer's privacy gate.
import { z } from 'zod'
import type { AppContext, Guide, ServiceInit, WorkMap } from '@shared/contracts'
import { getLlm } from './llm'
import { getSettings } from './settings'
import { getStore } from './store'

const request = z.object({ question: z.string().trim().min(2).max(1000) }).strict()
const response = z.object({ answer: z.string().trim().min(1).max(2400) }).strict()
const words = (value: string) => new Set((value.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((word) => !['what', 'when', 'how', 'the', 'and', 'for', 'this', 'that', 'about', 'with'].includes(word)))

async function answer(ctx: AppContext, question: string): Promise<{ answer: string; source: 'model' | 'local'; guide?: string }> {
  const safeQuestion = (await ctx.bus.request('observer:redact', { text: question })).text.trim()
  if (!safeQuestion) throw new Error('The question could not be prepared safely. Try again.')
  const store = getStore(ctx)
  const files = (await store.list(['guides'])).filter((file) => file.endsWith('.json')).slice(-30)
  const guides = (await Promise.all(files.map((file) => store.read<Guide>(['guides', file]).catch(() => null)))).filter((guide): guide is Guide => !!guide)
  const query = words(safeQuestion)
  const score = (guide: Guide) => {
    const title = words(guide.title)
    const body = words(guide.steps.slice(0, 30).map((step) => `${step.title} ${step.note}`).join(' '))
    return [...query].reduce((total, word) => total + (title.has(word) ? 3 : 0) + (body.has(word) ? 1 : 0), 0)
  }
  const ranked = guides.map((guide) => ({ guide, score: score(guide) })).sort((a, b) => b.score - a.score)
  const picked = ranked[0]?.score > 0 ? ranked[0].guide : null
  let map: WorkMap | null = null
  if (picked) {
    const maps = (await store.list(['workmaps'])).filter((file) => file.endsWith('.json')).slice(-30)
    for (const file of maps) {
      const candidate = await store.read<WorkMap>(['workmaps', file]).catch(() => null)
      if (candidate?.guide === picked.id) { map = candidate; break }
    }
  }
  const settings = getSettings()
  const context = picked ? {
    title: picked.title,
    steps: picked.steps.slice(0, 24).map((step) => ({ title: step.title, note: step.note, quote: step.quote?.text })),
    workmap: map?.steps.slice(0, 16).map((step) => ({ title: step.title, decision: step.decision, reason: step.reason.text, guardrails: step.guardrails.map((rail) => ({ rule: rail.rule, quote: rail.quote })) })),
    confirmed: map?.status === 'confirmed',
  } : null
  try {
    const result = await getLlm(ctx).fast({
      appKeys: picked ? picked.app_keys?.length ? picked.app_keys : [picked.app || 'apprentice'] : ['apprentice'],
      system: 'You are Protégé, a concise training assistant. Help the user at any time. Use the provided company, role and recorded task only as context. A Work Map marked draft is unconfirmed. Never invent company policy, a guardrail, or an expert quote. If evidence is missing, say what is missing and suggest the next useful action. Keep the answer clear and under 160 words.',
      input: JSON.stringify({ company: settings.company, role: settings.role, teaching: settings.teaching, question: safeQuestion, recorded_evidence: context }),
      schema: response,
      maxTokens: 700,
    })
    return { answer: (await ctx.bus.request('observer:redact', { text: result.answer })).text, source: 'model', guide: picked?.title }
  } catch {
    if (picked) {
      const summary = picked.steps.filter((step) => step.kind !== 'switch').slice(0, 5).map((step, i) => `${i + 1}. ${step.title}`).join('\n')
      return { answer: `I found a recording called “${picked.title}”.${summary ? ` Its first steps are:\n${summary}` : ' It has no captured steps yet.'}\n\nFor a detailed answer, check its Work Map or connect an OpenAI key in app/.env.`, source: 'local', guide: picked.title }
    }
    return { answer: 'I do not have a matching recording to ground that answer. Record the task and explain your decisions, or add an OpenAI key in app/.env for broader help.', source: 'local' }
  }
}

export const init: ServiceInit = (ctx) => {
  ctx.handle('assistant:ask', (payload: unknown) => answer(ctx, request.parse(payload).question))
}
