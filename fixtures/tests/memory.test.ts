import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { AppProfile, ContextEvent, MemoryApp, MemoryEntry } from '@shared/contracts'
import { createMemory, deleteEverything } from '../../app/src/main/services/memory'
import { compressLog, createRollup, localProfile, summarizeHabits } from '../../app/src/main/services/rollup'
import { pickQuestion, type PauseState } from '../../app/src/main/services/curiosity'
import { appDirectory, getStore } from '../../app/src/main/services/store'
import type { getLlm } from '../../app/src/main/services/llm'
import { harness } from './harness'

const ctxEvent = (t: number, key = 'browser:minierp.local', title = 'Invoice 4471'): ContextEvent => ({ type: 'context', t, app: 'msedge.exe', key, title, blocked: false, hwnd: 1, monitor: 1, window_rect: [0, 0, 10, 10], dpi_awareness: 'per_monitor', window_dpi: 96, monitor_scale: 1, capture: 'uia' })

test('memory logs masked events per app and day, counts active minutes, and skips tutor lessons', async () => {
  const h = await harness()
  const memory = createMemory(h.ctx)
  const t0 = Date.UTC(2026, 9, 4, 9) / 1000
  h.emit('observer:event', ctxEvent(t0))
  h.emit('observer:event', { type: 'text', t: t0 + 1, key: 'browser:minierp.local', title: 'Invoice 4471', delta: ['Supplier: Müller GmbH', 'Pay to [IBAN ••••3000]'] })
  h.emit('observer:event', { type: 'click', t: t0 + 2, x: 1, y: 1, button: 'left', target: { name: 'Cost center', control_type: 'Edit', automation_id: 'cost', rect: [0, 0, 1, 1], rect_trusted: true }, shot: null, shot_meta: null })
  for (let i = 0; i < 20; i++) h.emit('observer:event', { type: 'activity', t: t0 + 3 + i * 30, kind: 'typing' })
  h.emit('observer:event', { type: 'commit', t: t0 + 600, field: 'Cost center', old: '6100', new: '0400', rect: null, masked: false, source: 'uia', final: true })
  // Blocked: nothing is logged until the next allowed context.
  h.emit('observer:event', { type: 'blocked', t: t0 + 601, reason: 'password_manager' })
  h.emit('observer:event', { type: 'commit', t: t0 + 602, field: 'Secret', old: '', new: 'x', rect: null, masked: false, source: 'uia' })
  // Tutor lessons keep nothing.
  h.emit('session:started', { id: 'lesson', kind: 'tutor' })
  h.emit('observer:event', ctxEvent(t0 + 700, 'excel.exe', 'Q3.xlsx'))
  h.emit('observer:event', { type: 'commit', t: t0 + 701, field: 'Total', old: '', new: '9', rect: null, masked: false, source: 'uia' })
  h.emit('session:stopped', { id: 'lesson' })
  await memory.drain()

  const apps = await memory.apps()
  assert.deepEqual(apps.map((a) => a.key), ['browser:minierp.local'])
  assert.deepEqual(apps[0].days, ['2026-10-04'])
  assert.ok(apps[0].minutes >= 9.5 && apps[0].minutes <= 10.5, `minutes ${apps[0].minutes}`)
  const entries = await memory.entries('browser:minierp.local', '2026-10-04')
  assert.deepEqual(entries.map((e) => e.type), ['context', 'text', 'click', 'commit'])
  assert.ok(JSON.stringify(entries).includes('[IBAN ••••3000]'))
  assert.ok(!JSON.stringify(entries).includes('Secret'))
})

test('retention drops old raw logs; deletes work per day, per app and for everything', async () => {
  const h = await harness()
  const store = getStore(h.ctx)
  const memory = createMemory(h.ctx, { now: () => Date.UTC(2026, 9, 20) / 1000 })
  const dir = path.join(h.ctx.paths.memory, appDirectory('excel.exe'))
  await mkdir(dir, { recursive: true })
  const line = (t: number) => JSON.stringify({ type: 'context', t, key: 'excel.exe', title: 'Q3' }) + '\n'
  await writeFile(path.join(dir, '2026-10-01.jsonl'), line(Date.UTC(2026, 9, 1) / 1000))
  await writeFile(path.join(dir, '2026-10-19.jsonl'), line(Date.UTC(2026, 9, 19) / 1000))
  await store.write(['config', 'privacy.json'], { raw_retention_days: 7 })
  assert.equal(await memory.retention(), 1)
  assert.deepEqual((await memory.apps()).map((a: MemoryApp) => a.days), [['2026-10-19']])

  await store.write(['profiles', `${appDirectory('excel.exe')}.json`], { key: 'excel.exe' })
  await memory.remove({ key: 'excel.exe', day: '2026-10-19' })
  assert.deepEqual(await memory.apps(), [])
  await writeFile(path.join(dir, '2026-10-19.jsonl'), line(Date.UTC(2026, 9, 19) / 1000))
  await memory.remove({ key: 'excel.exe' })
  assert.equal(await store.read(['profiles', `${appDirectory('excel.exe')}.json`]), null)

  await store.write(['guides', 'guide-x.json'], { id: 'guide-x' })
  await store.writeBytes(['references', 'guide-x', 'policy.txt'], Buffer.from('Masked policy text'))
  let cleared = ''
  h.ctx.bus.on('data:cleared', (event) => { cleared = event.scope })
  await deleteEverything(h.ctx)
  assert.equal(await store.read(['guides', 'guide-x.json']), null)
  assert.equal(await store.readBytes(['references', 'guide-x', 'policy.txt']).catch(() => null), null)
  assert.equal(cleared, 'all')
})

test('App Profiles: model rollup, local fallback, typed curiosity answers are masked', async () => {
  const h = await harness()
  const memory = createMemory(h.ctx)
  const t0 = Date.now() / 1000 - 60
  h.emit('observer:event', ctxEvent(t0))
  h.emit('observer:event', { type: 'commit', t: t0 + 1, field: 'Cost center', old: '6100', new: '0400', rect: null, masked: false, source: 'uia' })
  h.emit('observer:event', { type: 'click', t: t0 + 2, x: 1, y: 1, button: 'left', target: { name: 'Post', control_type: 'Button', automation_id: 'post', rect: [0, 0, 1, 1], rect_trusted: true }, shot: null, shot_meta: null })
  await memory.drain()
  let seenLog = ''
  const model = { fast: async (request: { input: string }) => { seenLog = JSON.parse(request.input).new_log; return { name: 'MiniERP', purpose: 'Supplier invoices', recurring_tasks: [{ name: 'Code invoices', evidence: 3 }], screens_fields: ['Invoice detail'], patterns: [], exceptions: [], open_questions: ['Why do some invoices go to 0400?'], today: ['Coded 1 invoice'] } } } as unknown as ReturnType<typeof getLlm>
  // The rollup reads the shared memory singleton; point it at this test's memory by using the same context.
  const rollup = createRollup(h.ctx, { model, prompt: 'p' })
  const profile = (await rollup.rollup('browser:minierp.local'))!
  assert.equal(profile.purpose, 'Supplier invoices')
  assert.match(seenLog, /Cost center: 6100 → 0400/)
  assert.deepEqual(profile.open_questions, ['Why do some invoices go to 0400?'])
  const updates: AppProfile[] = []
  h.ctx.bus.on('profile:updated', (p) => updates.push(p))
  const answered = await rollup.answer('browser:minierp.local', 'Why do some invoices go to 0400?', 'Equipment over 5000 is capex. TEST_SECRET')
  assert.deepEqual(answered.open_questions, [])
  assert.equal(answered.expert_quotes[0].a, 'Equipment over 5000 is capex. [SECRET]')
  assert.equal(updates.length, 1)

  const offline = createRollup(h.ctx, { model: { fast: async () => { throw new Error('offline') } } as unknown as ReturnType<typeof getLlm>, prompt: 'p' })
  const local = (await offline.rollup('excel.exe'))!
  assert.equal(local.name, 'Excel')
  const stored = JSON.parse(await readFile(path.join(h.ctx.paths.root, 'profiles', `${appDirectory('excel.exe')}.json`), 'utf8'))
  assert.equal(stored.key, 'excel.exe')
})

test('local profile and compressed log come from the log itself', () => {
  const t = Date.now() / 1000
  const entries: MemoryEntry[] = [
    { type: 'context', t, key: 'k', title: 'Invoice 4471' },
    { type: 'commit', t, key: 'k', field: 'Cost center', old: '6100', new: '0400', masked: false },
    { type: 'commit', t, key: 'k', field: 'Cost center', old: '6100', new: '0400', masked: false },
    { type: 'click', t, key: 'k', target: 'Post', control_type: 'Button' },
    { type: 'text', t, key: 'k', title: 'Invoice 4471', lines: ['Amount 6,400.00'] },
  ]
  const p = localProfile('browser:minierp.local', entries, null)
  assert.equal(p.name, 'minierp.local')
  assert.deepEqual(p.recurring_tasks[0], { name: 'Enter Cost center', evidence: 2 })
  assert.deepEqual(p.today, ['2 field entries', '1 clicks', '1 screens'])
  const log = compressLog(entries)
  assert.ok(log.indexOf('Window titles') < log.indexOf('Field entries') && log.indexOf('Clicked') < log.indexOf('Visible text'))
  assert.ok(compressLog(entries, 40).length <= 40)
  const habits = summarizeHabits(entries)
  assert.deepEqual(habits.frequent_fields[0], { label: 'Cost center', count: 2 })
  assert.equal(habits.action_sequences[0].from, 'Enter Cost center')
  assert.equal(habits.action_sequences[0].to, 'Click Post')
  assert.ok(!JSON.stringify(habits).includes('0400')) // values never enter the habit dataset
  assert.ok(localProfile('browser:minierp.local', entries, null).open_questions.length > 0)
})

test('curiosity asks only at a natural pause and within its caps', () => {
  const now = 1_800_000_000
  const state: PauseState = { key: 'excel.exe', inAppSince: now - 120, lastInput: now - 8, lastAction: now - 20, lastPopup: 0, busy: false }
  const qs = ['Why is Q3 split by region?', 'What is column F?']
  assert.equal(pickQuestion(state, qs, { asked: [] }, now), qs[0])
  assert.equal(pickQuestion({ ...state, lastInput: now - 2 }, qs, { asked: [] }, now), null) // still typing
  assert.equal(pickQuestion({ ...state, lastAction: now - 300 }, qs, { asked: [] }, now), null) // no recent action
  assert.equal(pickQuestion({ ...state, busy: true }, qs, { asked: [] }, now), null) // a session is running
  assert.equal(pickQuestion(state, qs, { asked: [{ key: 'excel.exe', q: 'x', at: now - 600 }] }, now), null) // 1 per hour per app
  assert.equal(pickQuestion(state, qs, { asked: [{ key: 'excel.exe', q: qs[0], at: now - 4000 }] }, now), qs[1]) // not the same one again
  const today = [1, 2, 3].map((i) => ({ key: `app${i}`, q: 'q', at: now - i }))
  assert.equal(pickQuestion(state, qs, { asked: today }, now), null) // 3 per day
})
