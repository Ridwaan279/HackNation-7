import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile, access } from 'node:fs/promises'
import path from 'node:path'
import type { Guide, MasteryReport, UiControl, Violation, WorkMap } from '@shared/contracts'
import { amounts, createChecker, localCheck, thresholds } from '../../app/src/main/services/checker'
import { bestControl, createLocator, toScreen } from '../../app/src/main/services/locate'
import { buildReport, createMastery } from '../../app/src/main/services/mastery'
import type { getLlm } from '../../app/src/main/services/llm'
import { harness } from './harness'

const guide: Guide = {
  id: 'guide-s-1', title: 'Invoices', app: 'browser:127.0.0.1', session: 's-1', app_keys: ['browser:127.0.0.1'], steps: [
    { id: 'g1', n: 1, t: 2, kind: 'enter', title: 'Enter 0400 in Cost center', note: '', target: 'Cost center', value: '0400', old_value: '6100', shot: 'shots/a.jpg', highlight: null, blur: [], screen_moment: '', edited: false },
    { id: 'g2', n: 2, t: 5, kind: 'enter', title: 'Enter A-1 in Asset number', note: '', target: 'Asset number', value: 'A-1', old_value: '', shot: null, highlight: null, blur: [], screen_moment: '', edited: false },
    { id: 'g3', n: 3, t: 8, kind: 'click', title: 'Click Post', note: '', target: 'Post', shot: null, highlight: null, blur: [], screen_moment: '', edited: false },
  ],
}
const map: WorkMap = {
  id: 'wm-s-1', role: 'AP clerk', expert: 'Sabine', status: 'confirmed', guide: 'guide-s-1', open_questions: [], teachback: { confirmed: true, corrections: [] },
  steps: [
    { id: 's1', index: 1, title: 'Code equipment to capex', guide_steps: ['g1', 'g2'], t_start: 2, t_end: 5, decision: 'Re-coded 6100 → 0400', reason: { text: 'Equipment over €5,000 is always capex.', t: 4 }, judgment_call: true,
      guardrails: [{ id: 'g1', type: 'limit', rule: 'Equipment over €5,000 goes to capex 0400 with an asset number', quote: 'Equipment over €5,000 is always capex.', t: 4, source: 'live' }] },
    { id: 's2', index: 2, title: 'Post the invoice', guide_steps: ['g3'], t_start: 8, t_end: 8, decision: 'Posted', reason: { text: '', t: 0 }, judgment_call: false, guardrails: [] },
  ],
}
const form = (cost: string, amount: string, description: string): UiControl[] => [
  { name: 'Amount', control_type: 'Edit', automation_id: 'amount', rect: [0, 0, 10, 10], value: amount },
  { name: 'Description', control_type: 'Edit', automation_id: 'description', rect: [0, 20, 10, 30], value: description },
  { name: 'Cost center', control_type: 'Edit', automation_id: 'costCenter', rect: [100, 200, 300, 230], value: cost },
  { name: 'Cost center', control_type: 'Text', automation_id: '', rect: [100, 180, 200, 198] },
  { name: 'Post', control_type: 'Button', automation_id: 'post', rect: [10, 300, 60, 330] },
]
const save = { kind: 'save' as const, t: 10, target: 'Post' }

test('thresholds and amounts are read from rules and the screen', () => {
  assert.deepEqual(thresholds(map.steps[0]), [5000])
  assert.deepEqual(amounts(['Amount €7,200.00', '240.00', 'Invoice 4471', 'Cost center 6100', 'EUR 950']), [7200, 240, 950])
})

test('local rule: the €7,200 equipment invoice left on 6100 is caught, routine and small invoices are not', () => {
  const hit = localCheck(map, guide, form('6100', '7200.00', 'Production equipment: inspection station'), [], save)
  assert.equal(hit?.step.id, 's1')
  assert.equal(hit?.field, 'Cost center')
  assert.equal(hit?.quote.text, 'Equipment over €5,000 is always capex.')
  assert.equal(localCheck(map, guide, form('6100', '240.00', 'Office stationery'), [], save), null)
  assert.equal(localCheck(map, guide, form('6100', '3000.00', 'Production equipment: small tool'), [], save), null) // under the threshold
  assert.equal(localCheck(map, guide, form('0400', '7200.00', 'Production equipment'), [], save), null) // already right
})

async function lesson(model: ReturnType<typeof getLlm>, controls: UiControl[]) {
  const h = await harness()
  h.ctx.bus.handle('brain:workmap', ({ id }) => (id === map.id ? structuredClone(map) : null))
  h.ctx.bus.handle('brain:guide', ({ id }) => (id === guide.id ? structuredClone(guide) : null))
  h.ctx.bus.handle('observer:tree', () => ({ controls }))
  const checker = createChecker(h.ctx, { model, prompt: 'p' })
  const violations: Violation[] = []
  h.ctx.bus.on('tutor:violation', (v) => violations.push(v))
  await checker.start('lesson-1', map.id)
  h.emit('observer:event', { type: 'context', t: 1, app: 'msedge.exe', key: 'browser:127.0.0.1', title: 'MiniERP', blocked: false, hwnd: 1, monitor: 1, window_rect: [0, 0, 10, 10], dpi_awareness: 'per_monitor', window_dpi: 96, monitor_scale: 1, capture: 'uia' })
  return { h, checker, violations }
}
const postClick = (t: number) => ({ type: 'click' as const, t, x: 20, y: 310, button: 'left' as const, target: { name: 'Post', control_type: 'Button', automation_id: 'post', rect: [10, 300, 60, 330] as [number, number, number, number], rect_trusted: true }, shot: null, shot_meta: null })
const offline = { fast: async () => { throw new Error('offline') }, smart: async () => { throw new Error('offline') } } as unknown as ReturnType<typeof getLlm>

test('checker: clicking Post on the wrong coding raises one violation pointing at the field', async () => {
  const { h, checker, violations } = await lesson(offline, form('6100', '7200.00', 'Production equipment: inspection station'))
  h.emit('observer:event', postClick(10)); await checker.drain()
  h.emit('observer:event', postClick(11)); await checker.drain() // same problem: not repeated
  assert.equal(violations.length, 1)
  assert.equal(violations[0].session, 'lesson-1')
  assert.equal(violations[0].step_id, 's1')
  assert.equal(violations[0].guardrail_id, 'g1')
  assert.deepEqual(violations[0].rect, [100, 200, 300, 230]) // the field, not its label
  assert.match(violations[0].why, /Cost center is 6100/)
})

test('checker: the model decides when available, and nothing is checked outside a lesson', async () => {
  let calls = 0
  const says = (violation: boolean) => ({ fast: async () => { calls++; return { violation, step_id: violation ? 's1' : null, guardrail_id: violation ? 'g1' : null, field: 'Cost center', why: 'Equipment over €5,000 is capex.' } } }) as unknown as ReturnType<typeof getLlm>
  const no = await lesson(says(false), form('6100', '7200.00', 'Production equipment'))
  no.h.emit('observer:event', postClick(10)); await no.checker.drain()
  assert.equal(no.violations.length, 0) // the model's "no" wins over the local rule
  const yes = await lesson(says(true), form('6100', '7200.00', 'Production equipment'))
  yes.h.emit('observer:event', { type: 'commit', t: 9, field: 'Cost center', old: '6100', new: '6100x', rect: [1, 2, 3, 4], masked: false, source: 'uia' }); await yes.checker.drain()
  assert.equal(yes.violations[0].why, 'Equipment over €5,000 is capex.')
  yes.h.emit('session:stopped', { id: 'lesson-1' })
  const before = calls
  yes.h.emit('observer:event', postClick(30)); await yes.checker.drain()
  assert.equal(calls, before)
})

test('locate: fields beat labels; otherwise vision on a screenshot, mapped back to screen pixels', async () => {
  const controls = form('6100', '1', 'x')
  assert.deepEqual(bestControl('cost center', controls)?.rect, [100, 200, 300, 230])
  assert.equal(bestControl('the post button', controls)?.name, 'Post')
  assert.equal(bestControl('Approval queue', controls), null)
  assert.deepEqual(toScreen({ origin_px: [1280, 0], size_px: [1280, 1528], scale: 0.5, monitor: 1 }, 100, 50, 40, 20), [1440, 80, 1520, 120])

  const h = await harness()
  h.ctx.bus.handle('observer:tree', () => ({ controls }))
  await mkdir(path.join(h.ctx.paths.shots, 'tmp'), { recursive: true })
  const shotFile = path.join(h.ctx.paths.shots, 'tmp', 'locate.jpg')
  await writeFile(shotFile, Buffer.from([255, 216, 255, 224, 0, 0]))
  h.ctx.bus.handle('observer:shot', () => ({ path: 'shots/tmp/locate.jpg', meta: { origin_px: [0, 0], size_px: [1000, 800], scale: 1, monitor: 1 } }))
  const vision = { fast: async () => ({ found: true, x: 500, y: 400, width: 60, height: 30 }) } as unknown as ReturnType<typeof getLlm>
  const locator = createLocator(h.ctx, { model: vision, prompt: 'p' })
  h.emit('observer:event', { type: 'context', t: 1, app: 'msedge.exe', key: 'browser:127.0.0.1', title: 'MiniERP', blocked: false, hwnd: 1, monitor: 1, window_rect: [0, 0, 10, 10], dpi_awareness: 'per_monitor', window_dpi: 96, monitor_scale: 1, capture: 'uia' })
  assert.deepEqual(await h.request('brain:locate', { target: 'Cost center' }), { rect: [100, 200, 300, 230], source: 'uia' })
  assert.deepEqual(await locator.locate('Approval queue'), { rect: [470, 385, 530, 415], source: 'vision' })
  await assert.rejects(access(shotFile)) // the on-demand screenshot is deleted
})

test('locate: ambiguous names are settled on a screenshot, and the chosen control keeps its exact box', async () => {
  const controls = [
    { name: 'Save draft', control_type: 'Button', automation_id: '', rect: [10, 10, 90, 40] },
    { name: 'Save', control_type: 'Button', automation_id: 'save-top', rect: [100, 10, 160, 40] },
    { name: 'Save', control_type: 'Button', automation_id: 'save-bottom', rect: [100, 700, 160, 730] },
  ] as UiControl[]
  const h = await harness()
  h.ctx.bus.handle('observer:tree', () => ({ controls }))
  await mkdir(path.join(h.ctx.paths.shots, 'tmp'), { recursive: true })
  await writeFile(path.join(h.ctx.paths.shots, 'tmp', 'pick.jpg'), Buffer.from([255, 216, 255, 224, 0, 0]))
  h.ctx.bus.handle('observer:shot', () => ({ path: 'shots/tmp/pick.jpg', meta: { origin_px: [0, 0], size_px: [1000, 800], scale: 0.5, monitor: 1 } }))
  let seen: { candidates: { index: number; box: number[] }[] } | null = null
  // The "model" picks the lower Save button by where it is on the screenshot.
  const model = { fast: async (r: { input: string }) => {
    seen = JSON.parse(r.input)
    return { index: seen!.candidates.find((c) => c.box[1] === 350)?.index ?? -1 }
  } } as unknown as ReturnType<typeof getLlm>
  const locator = createLocator(h.ctx, { model, pickPrompt: 'p' })
  h.emit('observer:event', { type: 'context', t: 1, app: 'app.exe', key: 'app.exe', title: 'App', blocked: false, hwnd: 1, monitor: 1, window_rect: [0, 0, 10, 10], dpi_awareness: 'per_monitor', window_dpi: 96, monitor_scale: 1, capture: 'uia' })
  assert.deepEqual(await locator.locate('Save'), { rect: [100, 700, 160, 730], source: 'uia' })
  assert.ok(seen!.candidates.some((c) => JSON.stringify(c.box) === '[50,350,80,365]')) // boxes in image pixels (scale 0.5)
  assert.equal(seen!.candidates.length, 3)
  // No model available: still a real control with an exact box, never a guess.
  const h2 = await harness()
  h2.ctx.bus.handle('observer:tree', () => ({ controls }))
  await mkdir(path.join(h2.ctx.paths.shots, 'tmp'), { recursive: true })
  await writeFile(path.join(h2.ctx.paths.shots, 'tmp', 'pick.jpg'), Buffer.from([255, 216, 255, 224, 0, 0]))
  h2.ctx.bus.handle('observer:shot', () => ({ path: 'shots/tmp/pick.jpg', meta: { origin_px: [0, 0], size_px: [1000, 800], scale: 0.5, monitor: 1 } }))
  const offline = createLocator(h2.ctx, { model: { fast: async () => { throw new Error('no key') } } as unknown as ReturnType<typeof getLlm>, pickPrompt: 'p' })
  h2.emit('observer:event', { type: 'context', t: 1, app: 'app.exe', key: 'app.exe', title: 'App', blocked: false, hwnd: 1, monitor: 1, window_rect: [0, 0, 10, 10], dpi_awareness: 'per_monitor', window_dpi: 96, monitor_scale: 1, capture: 'uia' })
  const fallback = await offline.locate('Save')
  assert.ok(fallback && controls.some((c) => JSON.stringify(c.rect) === JSON.stringify(fallback.rect)))
})

test('mastery: outcomes per step, hints are not undone, the report is stored and opened', async () => {
  const marks = new Map([['s2', 'alone' as const]])
  const report = buildReport('l-1', map, marks, new Map([['s1', 'Cost center left on 6100']]), 1)
  assert.deepEqual(report.steps.map((s) => s.outcome), ['caught', 'alone'])
  assert.equal(report.summary, '1 of 2 steps done alone, 0 after a hint, 1 caught by a guardrail.')
  assert.match(report.practise_next[0], /capex 0400/)

  const h = await harness()
  h.ctx.bus.handle('brain:workmap', () => structuredClone(map))
  h.ctx.bus.handle('brain:guide', () => structuredClone(guide))
  let opened = ''
  const mastery = createMastery(h.ctx, { model: offline, prompt: 'p', open: (p) => { opened = p } })
  h.emit('session:started', { id: 'l-2', kind: 'tutor', workmap_id: map.id })
  h.emit('tutor:mark_step', { session: 'l-2', step_id: '2', outcome: 'hint' })
  h.emit('tutor:mark_step', { session: 'l-2', step_id: 's2', outcome: 'alone' })
  h.emit('tutor:violation', { session: 'l-2', step_id: 's1', guardrail_id: 'g1', why: 'Left on opex', quote: { text: 'q', t: 1 } })
  h.emit('session:stopped', { id: 'l-2' })
  await mastery.drain(); await mastery.drain()
  const [stored] = await h.invoke<MasteryReport[]>('mastery:list', {})
  assert.deepEqual(stored.steps.map((s) => s.outcome), ['caught', 'hint'])
  assert.equal(opened, 'lessons?session=l-2')
})
