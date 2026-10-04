import test from 'node:test'
import assert from 'node:assert/strict'
import type { ClickEvent, CommitEvent, ContextEvent, WorkMap } from '@shared/contracts'
import { createStepsService } from '../../app/src/main/services/steps'
import { createWorkmapService, verifyQuote } from '../../app/src/main/services/workmap'
import type { getLlm } from '../../app/src/main/services/llm'
import { harness } from './harness'

const context: ContextEvent = { type: 'context', t: 1, app: 'msedge.exe', key: 'browser:127.0.0.1', title: 'MiniERP', blocked: false, hwnd: 1, monitor: 1, window_rect: [0, 0, 1000, 900], dpi_awareness: 'per_monitor', window_dpi: 96, monitor_scale: 1, capture: 'uia' }
const click = (t: number, name: string, control_type = 'Edit'): ClickEvent => ({ type: 'click', t, x: 10, y: 10, button: 'left', target: { name, automation_id: name, control_type, rect: [0, 0, 100, 30], rect_trusted: true }, shot: null, shot_meta: null })
const commit = (t: number, field: string, old: string, value: string): CommitEvent => ({ type: 'commit', t, field, old, new: value, rect: [0, 0, 100, 30], masked: false, source: 'uia', final: true })
const QUOTE = 'Equipment over 5,000 euros is always capex, so it goes to 0400.'

async function session(h: Awaited<ReturnType<typeof harness>>, id: string) {
  h.emit('session:started', { id, kind: 'teach' })
  h.emit('observer:event', context)
  h.emit('observer:event', click(2, 'Cost center')); h.emit('observer:event', commit(3, 'Cost center', '6100', '0400'))
  h.emit('observer:event', click(5, 'Asset number')); h.emit('observer:event', commit(6, 'Asset number', '', 'A-1209'))
  h.emit('observer:event', click(8, 'Post', 'Button'))
  h.emit('agent:answer', { session: id, t: 4, question: 'Why 0400?', answer_quote: QUOTE, type: 'reason', related_event_t: 3, source: 'live' })
  h.emit('transcript:line', { session: id, t: 4, role: 'expert', text: QUOTE })
  h.emit('transcript:line', { session: id, t: 7, role: 'expert', text: 'Never book capex without an asset number.' })
}

test('quotes survive only as the expert\'s own words', () => {
  const evidence = [{ text: QUOTE, t: 4, source: 'live' as const }]
  assert.deepEqual(verifyQuote('always capex, so it goes to 0400', evidence), { text: 'always capex, so it goes to 0400', t: 4, source: 'live' })
  assert.equal(verifyQuote('Anything over a thousand needs a manager', evidence), null)
  assert.equal(verifyQuote('', evidence), null)
})

test('stop drafts a Work Map linked to guide steps; invented quotes are dropped; debrief, correction and teach-back update it', async () => {
  const h = await harness()
  const steps = createStepsService(h.ctx, { describe: async () => null })
  let guideIds: string[] = []
  const model = {
    fast: async () => ({ title: 'Code equipment to capex', decision: 'Cost center 6100 → 0400', reason: { text: 'Equipment is capex', t: 99 }, guardrails: [{ type: 'limit', rule: 'Capex needs an asset number', quote: { text: 'Never book capex without an asset number.', t: 7 } }] }),
    smart: async (request: { input: string }) => {
      guideIds = JSON.parse(request.input).guide_steps.map((step: { id: string }) => step.id)
      return {
        steps: [
          { title: 'Code the invoice', guide_steps: [guideIds[1], guideIds[2], 'not-a-step'], decision: 'Re-coded 6100 → 0400', reason: { text: QUOTE, t: 4 }, guardrails: [
            { type: 'limit', rule: 'No asset number, no capex', quote: { text: 'Never book capex without an asset number.', t: 7 } },
            { type: 'stop_and_ask', rule: 'Ask the CFO above 50k', quote: { text: 'Always ask the CFO above fifty thousand.', t: 1 } }, // never said
          ], judgment_call: true },
          { title: 'Post it', guide_steps: [guideIds[guideIds.length - 1]], decision: 'Posted', reason: null, guardrails: [], judgment_call: false },
        ],
        open_questions: ['When do you hold an invoice instead of posting it?', 'Which suppliers need a second approval?'],
      }
    },
  } as unknown as ReturnType<typeof getLlm>
  const service = createWorkmapService(h.ctx, { model, draftPrompt: 'draft', correctionPrompt: 'fix', guideWaitMs: 2000 })
  const updates: WorkMap[] = []
  h.ctx.bus.on('workmap:updated', (map) => updates.push(map))
  await session(h, 's-1')
  h.emit('session:stopped', { id: 's-1' })
  await steps.drain(); await service.drain()

  const draft = updates.at(-1)!
  assert.equal(draft.id, 'wm-s-1')
  assert.equal(draft.status, 'draft')
  assert.equal(draft.guide, 'guide-s-1')
  assert.deepEqual(draft.steps[0].guide_steps, [guideIds[1], guideIds[2]]) // unknown ids dropped
  assert.equal(draft.steps[0].reason.text, QUOTE)
  assert.deepEqual(draft.steps[0].guardrails.map((g) => g.rule), ['No asset number, no capex']) // the invented one is gone
  assert.equal(draft.steps[0].t_start, 2)
  const guide = await h.request('brain:guide', { id: 'guide-s-1' })
  assert.equal(guide!.steps.find((step) => step.id === guideIds[1])!.old_value, '6100')

  // Debrief answer: closes the matching open question, adds a guardrail.
  h.emit('agent:answer', { session: 's-1', t: 20, question: 'When do you hold an invoice instead of posting it?', answer_quote: 'December invoices from Müller get held until I check for double billing.', type: 'exception', source: 'debrief' })
  await steps.drain(); await service.drain()
  let map = updates.at(-1)!
  assert.deepEqual(map.open_questions, ['Which suppliers need a second approval?'])
  assert.ok(map.steps.some((step) => step.guardrails.some((g) => g.type === 'exception' && g.quote.startsWith('December invoices'))))

  // Correction: the model rewrites the step; its invented reason is replaced by nothing new.
  h.emit('agent:correction', { session: 's-1', step_id: 's1', correction_quote: 'Actually it is 0400 only for production equipment.' })
  await service.drain()
  map = updates.at(-1)!
  assert.equal(map.steps[0].title, 'Code equipment to capex')
  assert.equal(map.steps[0].reason.text, QUOTE) // "Equipment is capex" was never said, so the old reason stays
  assert.deepEqual(map.teachback.corrections, [{ step_id: 's1', quote: 'Actually it is 0400 only for production equipment.' }])

  h.emit('agent:teachback_confirmed', { session: 's-1', t: 30 })
  await service.drain()
  map = updates.at(-1)!
  assert.equal(map.status, 'confirmed')
  assert.deepEqual(map.teachback.confirmed, true)

  const replay = await h.request('brain:stepsFor', { workmap_id: 'wm-s-1', step_id: 's1' })
  assert.deepEqual(replay.map((step) => step.target), ['Cost center', 'Asset number'])
  assert.deepEqual(await h.request('brain:stepsFor', { workmap_id: 'wm-s-1', step_id: '1' }), replay) // index works too
  const listed = await h.invoke<WorkMap[]>('workmaps:list', {})
  assert.equal(listed[0].id, 'wm-s-1')
})

test('without a model the draft is built locally from the guide and the expert\'s answers', async () => {
  const h = await harness()
  const steps = createStepsService(h.ctx, { describe: async () => null })
  const offline = { fast: async () => { throw new Error('offline') }, smart: async () => { throw new Error('offline') } } as unknown as ReturnType<typeof getLlm>
  const service = createWorkmapService(h.ctx, { model: offline, draftPrompt: 'x', correctionPrompt: 'y', guideWaitMs: 2000 })
  await session(h, 's-2')
  h.emit('session:stopped', { id: 's-2' })
  await steps.drain(); await service.drain()
  const map = (await service.load('wm-s-2'))!
  assert.ok(map.steps.length >= 2)
  assert.equal(map.steps[0].decision, 'Cost center: 6100 → 0400')
  assert.equal(map.steps[0].reason.text, QUOTE)
  assert.ok(map.open_questions.some((q) => /stop and ask/.test(q)))
  // Correction without a model: the expert's words become the reason.
  h.emit('agent:correction', { session: 's-2', step_id: '1', correction_quote: 'Only production equipment.' })
  await service.drain()
  assert.equal((await service.load('wm-s-2'))!.steps[0].reason.text, 'Only production equipment.')
})

test('quick guides get no Work Map', async () => {
  const h = await harness()
  const steps = createStepsService(h.ctx, { describe: async () => null })
  const service = createWorkmapService(h.ctx, { guideWaitMs: 200 })
  h.emit('session:started', { id: 'q-1', kind: 'quick_guide' })
  h.emit('observer:event', context); h.emit('observer:event', click(2, 'Post', 'Button'))
  h.emit('session:stopped', { id: 'q-1' })
  await steps.drain(); await service.drain()
  assert.equal(await service.load('wm-q-1'), null)
})
