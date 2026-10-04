import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, mkdir, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { JsonStore, appDirectory, defaultPaths } from '../../app/src/main/services/store'
import { createLlm, type ModelTransport, type ModelRequest } from '../../app/src/main/services/llm'
import type { SidecarEvent } from '@shared/contracts'

const fixtureRoot = fileURLToPath(new URL('../', import.meta.url))
const output = path.join(fixtureRoot, '.test-output')
await mkdir(output, { recursive: true })
const rect = z.tuple([z.number(), z.number(), z.number(), z.number()])
const stamp = { t: z.number().positive() }
const eventSchema = z.discriminatedUnion('type', [
  z.object({ ...stamp, type: z.literal('context'), app: z.string(), key: z.string(), title: z.string(), blocked: z.literal(false), hwnd: z.number(), monitor: z.number(), window_rect: rect, dpi_awareness: z.enum(['unaware', 'system', 'per_monitor', 'unknown']), window_dpi: z.number(), monitor_scale: z.number().positive(), capture: z.enum(['uia', 'vision']) }).strict(),
  z.object({ ...stamp, type: z.literal('text'), key: z.string(), title: z.string(), delta: z.array(z.string()) }).strict(),
  z.object({ ...stamp, type: z.literal('commit'), field: z.string(), old: z.string(), new: z.string(), rect: rect.nullable(), masked: z.boolean(), source: z.enum(['uia', 'vision']) }).strict(),
  z.object({ ...stamp, type: z.literal('activity'), kind: z.enum(['typing', 'mouse', 'scroll']) }).strict(),
  z.object({ ...stamp, type: z.literal('key'), key: z.enum(['enter', 'tab', 'esc', 'ctrl+s', 'ctrl+enter']) }).strict(),
  z.object({ ...stamp, type: z.literal('blocked'), reason: z.enum(['password_manager', 'banking', 'private_window', 'system', 'user_blocked', 'paused', 'off_record', 'self']) }).strict(),
  z.object({ ...stamp, type: z.literal('click'), x: z.number(), y: z.number(), button: z.enum(['left', 'right', 'middle']), target: z.object({ name: z.string(), control_type: z.string(), automation_id: z.string(), rect, rect_trusted: z.boolean() }).strict().nullable(), shot: z.null(), shot_meta: z.null() }).strict(),
  z.object({ ...stamp, type: z.literal('shot'), key: z.string(), path: z.string(), reason: z.enum(['heartbeat', 'ambient', 'vision_mode', 'on_demand']), ephemeral: z.boolean(), meta: z.object({ origin_px: z.tuple([z.number(), z.number()]), size_px: z.tuple([z.number().positive(), z.number().positive()]), scale: z.number().positive(), monitor: z.number() }).strict() }).strict(),
]) satisfies z.ZodType<SidecarEvent>

test('store serializes concurrent writes and appends, round-trips Unicode, and deletes a document', async () => {
  const store = new JsonStore(await mkdtemp(path.join(output, 'store-')))
  await Promise.all(Array.from({ length: 30 }, (_, index) => store.write(['guides', 'one.json'], { index, title: '€ · Müller' })))
  assert.deepEqual(await store.read(['guides', 'one.json']), { index: 29, title: '€ · Müller' })
  await Promise.all(Array.from({ length: 30 }, (_, index) => store.append(['memory', 'day.jsonl'], { index })))
  assert.deepEqual((await store.lines<{index: number}>(['memory', 'day.jsonl'])).map((line) => line.index), Array.from({ length: 30 }, (_, index) => index))
  assert.deepEqual(await store.list(['guides']), ['one.json'])
  await store.remove(['guides', 'one.json'])
  assert.equal(await store.read(['guides', 'one.json']), null)
})

test('store rejects traversal, Windows devices, and corrupt JSON', async () => {
  const store = new JsonStore(await mkdtemp(path.join(output, 'paths-')))
  for (const bad of ['..', '../secret', 'C:\\secret', 'a/b', 'a\\b', 'NUL.json', 'COM1', 'trailing.', 'stream:private', '']) {
    assert.throws(() => store.file('guides', bad))
  }
  await writeFile(store.file('broken.json'), '{broken')
  await assert.rejects(store.read(['broken.json']), SyntaxError)
  assert.equal(appDirectory('browser:example.test').length, 64)
  assert.notEqual(appDirectory('a:b'), appDirectory('a_b'))
  assert.throws(() => defaultPaths('relative'))
})

test('store rejects directory junction escapes', async () => {
  const root = await mkdtemp(path.join(output, 'junction-'))
  const outside = await mkdtemp(path.join(output, 'outside-'))
  await symlink(outside, path.join(root, 'escape'), 'junction')
  await assert.rejects(new JsonStore(root).write(['escape', 'leak.json'], {}), /links/)
})

const resultSchema = z.object({ title: z.string(), evidence: z.number().int() }).strict()
const request: ModelRequest<z.infer<typeof resultSchema>> = { appKeys: ['browser:127.0.0.1'], system: 'Describe the evidence.', input: 'Masked invoice', schema: resultSchema }
function model(options: { text?: string; stop?: string; local?: string[]; privacy?: null; fail?: boolean } = {}) {
  const calls: unknown[] = []
  const transport: ModelTransport = { messages: { create: async (payload) => {
    calls.push(payload)
    if (options.fail) throw new Error('sensitive-provider-response')
    return { content: [{ type: 'text', text: options.text ?? '{"title":"Invoice","evidence":1}', citations: null }], stop_reason: (options.stop ?? 'end_turn') as 'end_turn' }
  } } }
  return { calls, client: createLlm({ fastModel: 'test-fast', smartModel: 'test-smart', privacy: async () => options.privacy === null ? null : { local_only_apps: options.local ?? [] }, transport }) }
}

test('LLM selects configured tiers, supplies image blocks, and validates output', async () => {
  const { client, calls } = model()
  assert.deepEqual(await client.fast(request), { title: 'Invoice', evidence: 1 })
  await client.smart({ ...request, images: [{ media_type: 'image/png', data: 'AAAA' }] })
  assert.equal((calls[0] as {model: string}).model, 'test-fast')
  assert.equal((calls[1] as {model: string}).model, 'test-smart')
  assert.match(JSON.stringify(calls[1]), /image\/png/)
})

test('LLM fails closed for local-only apps, absent policy, and absent app provenance', async () => {
  for (const options of [{ local: ['browser:127.0.0.1'] }, { local: ['127.0.0.1'] }, { privacy: null }]) {
    const { client, calls } = model(options)
    await assert.rejects(client.fast(request), { code: 'privacy' })
    assert.equal(calls.length, 0)
  }
  const { client, calls } = model()
  await assert.rejects(client.fast({ ...request, appKeys: [] }), { code: 'privacy' })
  assert.equal(calls.length, 0)
})

test('LLM rejects malformed, schema-invalid, and truncated results; hides provider errors', async () => {
  for (const options of [{ text: 'not json' }, { text: '{"title":42}' }, { stop: 'max_tokens' }]) {
    await assert.rejects(model(options).client.fast(request), { code: 'invalid_output' })
  }
  await assert.rejects(model({ fail: true }).client.fast(request), (error: Error) => !error.message.includes('sensitive-provider-response'))
  assert.equal((await model({ text: '```json\n{"title":"Invoice","evidence":1}\n```' }).client.fast(request)).title, 'Invoice')
})

test('replays have ordered timestamps, masked values, control-only keys and real screenshots', async () => {
  const seen = new Set<string>()
  for (const name of ['expert-session', 'newhire-session', 'ambient-day']) {
    const raw = await readFile(path.join(fixtureRoot, `${name}.jsonl`), 'utf8')
    assert.doesNotMatch(raw, /4242 4242 4242 4242|DE89 3704|password.*value/i)
    const events: SidecarEvent[] = raw.trim().split('\n').map((line) => eventSchema.parse(JSON.parse(line)))
    let last = 0
    for (const event of events) {
      assert.ok(event.t >= last)
      last = event.t
      if (event.type === 'context') seen.add(event.key)
      if (event.type === 'key') assert.ok(['enter', 'tab', 'esc', 'ctrl+s', 'ctrl+enter'].includes(event.key))
      if (event.type === 'blocked') assert.deepEqual(Object.keys(event).sort(), ['reason', 't', 'type'])
      if (event.type === 'shot') {
        const bytes = await readFile(path.join(fixtureRoot, '..', event.path))
        assert.equal(bytes.readUInt16BE(0), 0xffd8)
        let offset = 2
        while (![0xc0, 0xc1, 0xc2].includes(bytes[offset + 1])) offset += 2 + bytes.readUInt16BE(offset + 2)
        assert.deepEqual([bytes.readUInt16BE(offset + 7), bytes.readUInt16BE(offset + 5)], event.meta.size_px)
      }
    }
  }
  assert.equal(seen.size, 3)
})
