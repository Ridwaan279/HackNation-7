import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import type { ClickEvent, CommitEvent, ContextEvent, Guide, SidecarEvent } from '@shared/contracts'
import { CaptureSession, createStepsService, editGuide, guideHtml } from '../../app/src/main/services/steps'
import { createDescriber, shotStorage } from '../../app/src/main/services/describe'
import { getStore, JsonStore, appDirectory } from '../../app/src/main/services/store'
import type { getLlm } from '../../app/src/main/services/llm'
import { harness } from './harness'

const context: ContextEvent = { type: 'context', t: 1, app: 'msedge.exe', key: 'browser:127.0.0.1', title: 'MiniERP', blocked: false, hwnd: 1, monitor: 1, window_rect: [0, 0, 1000, 900], dpi_awareness: 'per_monitor', window_dpi: 96, monitor_scale: 1, capture: 'uia' }
const click = (t: number, name = 'Cost center', control_type = 'EditControl'): ClickEvent => ({ type: 'click', t, x: 10, y: 10, button: 'left', target: { name, automation_id: name, control_type, rect: [0, 0, 100, 30], rect_trusted: true }, shot: null, shot_meta: null })
const commit = (t: number, value: string, final = false): CommitEvent & {final: boolean} => ({ type: 'commit', t, field: 'Cost center', old: '', new: value, rect: [0, 0, 100, 30], masked: false, source: 'uia', final })
const model = (value: unknown, reject = false) => ({ fast: async () => { if (reject) throw new Error('offline'); return value }, smart: async () => value }) as ReturnType<typeof getLlm>

test('the task entered before recording stays the guide title as apps change', () => {
  const capture = new CaptureSession('task-title', 'teach', 'Approve an equipment invoice')
  capture.push(context)
  capture.push({ ...context, t: 2, key: 'excel.exe', app: 'excel.exe', title: 'Budget workbook' })
  assert.equal(capture.guide.title, 'Approve an equipment invoice')
  assert.deepEqual(capture.guide.app_keys, ['browser:127.0.0.1', 'msedge.exe', 'excel.exe'])
})

test('capture coalesces idle commits through final commit, but a new field visit creates a step', () => {
  const capture = new CaptureSession('capture', 'teach')
  capture.push(context); capture.push(click(2)); capture.push(commit(3, '04')); capture.push(commit(4, '040')); capture.push(commit(5, '0400', true))
  assert.equal(capture.guide.steps.length, 2)
  assert.equal(capture.guide.steps[1].title, 'Enter 0400 in Cost center')
  capture.push({ type: 'key', key: 'enter', t: 5.5 })
  assert.match(capture.guide.steps[1].note, /enter/)
  capture.push(click(8)); capture.push(commit(9, '6100', true))
  assert.equal(capture.guide.steps.length, 3)
})
test('commit after clicking the next field still updates the original field step', () => {
  const capture = new CaptureSession('focus', 'teach')
  capture.push(context); capture.push(click(2)); capture.push(click(4, 'Asset number')); capture.push(commit(4.1, '0400', true))
  assert.equal(capture.guide.steps[1].kind, 'enter')
  assert.equal(capture.guide.steps[2].target, 'Asset number')
})
test('double clicks merge, blocked events discard pending edits, app switches isolate fields', () => {
  const capture = new CaptureSession('paused', 'teach')
  capture.push(context); capture.push(click(2, 'Post', 'ButtonControl')); capture.push(click(2.3, 'Post', 'ButtonControl'))
  assert.equal(capture.guide.steps.length, 2)
  assert.equal(capture.guide.steps[1].title, 'Double-click Post')
  capture.push({ type: 'blocked', t: 4, reason: 'paused' })
  assert.equal(capture.push(commit(5, 'hidden')), false)
  capture.push({ ...context, t: 6, key: 'excel.exe', title: 'Excel' }); capture.push(commit(7, 'new'))
  assert.equal(capture.guide.steps.at(-1)?.app_key, 'excel.exe')
})
test('guide edits enforce stop, preserve remaining screenshots and renumber', () => {
  const capture = new CaptureSession('editing', 'teach')
  capture.push(context); capture.push(click(2)); capture.push(commit(3, '0400'))
  assert.throws(() => editGuide(capture.guide, { kind: 'delete', step_id: capture.guide.steps[0].id }), /Stop/)
  capture.guide.recording = false
  const withNote = editGuide(capture.guide, { kind: 'note', after_id: capture.guide.steps[0].id, note: 'Check this' })
  const moved = editGuide(withNote, { kind: 'move', step_id: withNote.steps[1].id, direction: 'down' })
  const merged = editGuide(moved, { kind: 'merge', step_id: moved.steps[2].id })
  assert.equal(merged.steps.length, 2)
  assert.match(merged.steps[1].note, /Check this/)
  assert.deepEqual(merged.steps.map((step) => step.n), [1, 2])
})
test('service emits and persists a guide; stale edits fail; notes and answers are redacted', async () => {
  const h = await harness()
  const service = createStepsService(h.ctx, { describe: async () => null })
  h.emit('session:started', { id: 'service', kind: 'teach' }); h.emit('observer:event', context); h.emit('observer:event', click(2)); h.emit('observer:event', commit(3, '0400'))
  h.emit('session:stopped', { id: 'service' }); await service.drain()
  const guide = (await service.list())[0]
  assert.equal(guide.recording, false)
  assert.ok(h.broadcasts.some((item) => item.channel === 'guide:updated'))
  const saved = await h.invoke<Guide>('guide:save', { id: guide.id, revision: guide.revision, edit: { kind: 'rename', title: 'TEST_SECRET' } })
  assert.equal(saved.title, '[SECRET]')
  await assert.rejects(h.invoke('guide:save', { id: guide.id, revision: guide.revision, edit: { kind: 'rename', title: 'stale' } }), /changed/)
  h.emit('agent:answer', { session: 'service', t: 4, question: 'Why TEST_SECRET?', answer_quote: 'Because TEST_SECRET.', type: 'reason', related_event_t: 3, source: 'live' })
  await service.drain()
  const answers = await getStore(h.ctx).lines<{answer_quote: string}>(['sessions', 'service', 'answers.jsonl'])
  assert.equal(answers[0].answer_quote, 'Because [SECRET].')
  assert.match((await h.request('brain:guide', { id: guide.id }))!.steps[1].quote!.text, /\[SECRET\]/)
  h.emit('session:started', { id: 'tutor', kind: 'tutor' }); h.emit('observer:event', context); h.emit('observer:event', click(5))
  await service.drain(); assert.equal((await service.list()).length, 1)
})
test('question selection forces a first guardrail, avoids repeat events, and stops when blocked', async () => {
  const h = await harness()
  const service = createStepsService(h.ctx, { model: model(null, true), questionPrompt: 'test', describe: async () => null })
  h.emit('session:started', { id: 'question', kind: 'teach' }); h.emit('observer:event', context); h.emit('observer:event', commit(2, '0400'))
  const first = await h.request('brain:pickQuestion', { session: 'question' })
  assert.equal(first?.type, 'guardrail'); assert.equal(first?.about_event_t, 2)
  assert.equal(await h.request('brain:pickQuestion', { session: 'question' }), null)
  h.emit('observer:event', click(4, 'Hold invoice', 'ButtonControl'))
  assert.equal((await h.request('brain:pickQuestion', { session: 'question' }))?.type, 'reason')
  h.emit('observer:event', { type: 'blocked', t: 5, reason: 'paused' })
  assert.equal(await h.request('brain:pickQuestion', { session: 'question' }), null)
  await service.drain()
})
test('late question results are withheld after stop', async () => {
  const h = await harness()
  let resolve!: (result: unknown) => void
  const delayed = new Promise((done) => { resolve = done })
  const service = createStepsService(h.ctx, { model: { fast: () => delayed, smart: () => delayed } as ReturnType<typeof getLlm>, questionPrompt: 'test' })
  h.emit('session:started', { id: 'late', kind: 'teach' }); h.emit('observer:event', context); h.emit('observer:event', commit(2, '0400'))
  const question = h.request('brain:pickQuestion', { session: 'late' })
  h.emit('session:stopped', { id: 'late' })
  resolve({ question: 'When would you stop?', type: 'guardrail', about_event_t: 2 })
  assert.equal(await question, null)
  await service.drain()
})
test('describer supports A runtime paths, redacts text and always deletes ephemeral images', async () => {
  const h = await harness()
  const image = await readFile(new URL('../shots/expert-capex.jpg', import.meta.url))
  const shots = new JsonStore(h.ctx.paths.shots)
  await shots.writeBytes(['tmp', 'one.jpg'], image)
  const describer = createDescriber(h.ctx, { model: model({ screen_moment: 'TEST_SECRET invoice', target: null }), prompt: 'test' })
  assert.equal((await describer.describe({ path: 'shots/tmp/one.jpg', appKeys: ['browser:127.0.0.1'], t: 1720000000, ephemeral: true }))?.screen_moment, '[SECRET] invoice')
  await assert.rejects(shots.readBytes(['tmp', 'one.jpg']), { code: 'ENOENT' })
  const logs = await getStore(h.ctx).lines<{text: string}>(['memory', appDirectory('browser:127.0.0.1'), '2024-07-03.jsonl'])
  assert.equal(logs[0].text, '[SECRET] invoice')
  await shots.writeBytes(['tmp', 'two.jpg'], image)
  const failed = createDescriber(h.ctx, { model: model(null, true), prompt: 'test' })
  await assert.rejects(failed.describe({ path: 'shots/tmp/two.jpg', appKeys: ['test'], t: 1720000000, ephemeral: true }))
  await assert.rejects(shots.readBytes(['tmp', 'two.jpg']), { code: 'ENOENT' })
  assert.throws(() => shotStorage(h.ctx, '../outside.jpg'))
  assert.throws(() => shotStorage(h.ctx, 'config/privacy.json'))
})
test('HTML export escapes user text and omits hidden screenshots', async () => {
  const h = await harness()
  const capture = new CaptureSession('html', 'teach')
  capture.push(context); capture.push(click(2))
  capture.guide.title = '<script>bad()</script>'
  capture.guide.steps[1].shot = 'shots/missing.jpg'; capture.guide.steps[1].screenshot_hidden = true
  const html = await guideHtml(h.ctx, capture.guide)
  assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>/); assert.doesNotMatch(html, /<img/)
})
test('full expert fixture creates capex, hold and approval steps without tutor storage', async () => {
  const events: SidecarEvent[] = (await readFile(new URL('../expert-session.jsonl', import.meta.url), 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  const capture = new CaptureSession('replay', 'teach')
  events.forEach((event) => capture.push(event))
  assert.ok(capture.guide.steps.some((step) => step.title.includes('0400')))
  assert.ok(capture.guide.steps.some((step) => step.target === 'Hold invoice'))
  assert.ok(capture.guide.steps.some((step) => step.target === 'Send for approval'))
})
