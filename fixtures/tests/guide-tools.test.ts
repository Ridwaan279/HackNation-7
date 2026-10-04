import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ClickEvent, CommitEvent, ContextEvent, Guide, WorkMap } from '@shared/contracts'
import { addWhy, applyPolish, createStepsService, guideMarkdown, localPolish } from '../../app/src/main/services/steps'
import { getStore } from '../../app/src/main/services/store'
import type { getLlm } from '../../app/src/main/services/llm'
import { harness } from './harness'

const context = (t: number, title = 'MiniERP'): ContextEvent => ({ type: 'context', t, app: 'msedge.exe', key: 'browser:127.0.0.1', title, blocked: false, hwnd: 1, monitor: 1, window_rect: [0, 0, 10, 10], dpi_awareness: 'per_monitor', window_dpi: 96, monitor_scale: 1, capture: 'uia' })
const click = (t: number, name: string, control_type: string, shot: string | null = null): ClickEvent => ({ type: 'click', t, x: 1, y: 1, button: 'left', target: { name, control_type, automation_id: name, rect: [0, 0, 5, 5], rect_trusted: true }, shot, shot_meta: shot ? { origin_px: [0, 0], size_px: [5, 5], scale: 1, monitor: 1 } : null })
const commit = (t: number): CommitEvent => ({ type: 'commit', t, field: 'Cost center', old: '6100', new: '0400', rect: null, masked: false, source: 'uia', final: true })

async function recorded() {
  const h = await harness()
  await mkdir(path.join(h.ctx.paths.shots, '2026-10-04'), { recursive: true })
  await writeFile(path.join(h.ctx.paths.shots, '2026-10-04', 'a.jpg'), Buffer.from([255, 216, 255, 224, 1, 2, 3]))
  const offline = { fast: async () => { throw new Error('offline') }, smart: async () => { throw new Error('offline') } } as unknown as ReturnType<typeof getLlm>
  const out = path.join(h.ctx.paths.root, 'exports')
  const service = createStepsService(h.ctx, { describe: async () => null, model: offline, polishPrompt: 'p', saveFile: async (name, ext) => path.join(out, `${name}.${ext}`), chooseFolder: async () => out })
  await mkdir(out, { recursive: true })
  h.emit('session:started', { id: 's-9', kind: 'teach' })
  h.emit('observer:event', context(1))
  h.emit('observer:event', click(2, 'Spike test page', 'Document'))
  h.emit('observer:event', click(3, 'Cost center', 'Edit', 'shots/2026-10-04/a.jpg'))
  h.emit('observer:event', commit(4))
  h.emit('session:stopped', { id: 's-9' })
  await service.drain()
  const guide = (await service.list())[0]
  return { h, service, guide, out }
}

test('polish without a model drops empty-page clicks and repeated switches but keeps explained steps', () => {
  const steps = [
    { id: 'a', n: 1, t: 1, kind: 'switch', title: 'Switch to A', note: '', target: '', shot: null, highlight: null, blur: [], screen_moment: '', edited: false },
    { id: 'b', n: 2, t: 2, kind: 'switch', title: 'Switch to B', note: '', target: '', shot: null, highlight: null, blur: [], screen_moment: '', edited: false },
    { id: 'c', n: 3, t: 3, kind: 'click', title: 'Click page', note: '', target: 'page', shot: null, highlight: null, blur: [], screen_moment: '', edited: false },
    { id: 'd', n: 4, t: 4, kind: 'click', title: 'Click page', note: '', target: 'page', shot: null, highlight: null, blur: [], screen_moment: '', edited: false, quote: { text: 'I always check here', t: 4 } },
  ] as Guide['steps']
  const guide: Guide = { id: 'g', title: 'T', app: 'x', session: 's', steps }
  const polished = applyPolish(guide, localPolish(guide))
  assert.deepEqual(polished.steps.map((s) => s.id), ['a', 'd'])
  assert.deepEqual(polished.steps.map((s) => s.n), [1, 2])
})

test('Polish, Add the why and the HTML / Markdown exports through IPC', async () => {
  const { h, guide, out } = await recorded()
  assert.ok(guide.steps.some((s) => s.target === 'page'))
  const polished = await h.invoke<Guide>('guide:polish', { id: guide.id, revision: guide.revision })
  assert.ok(!polished.steps.some((s) => s.target === 'page'))
  await assert.rejects(h.invoke('guide:polish', { id: guide.id, revision: guide.revision }), /changed/) // stale revision

  await assert.rejects(h.invoke('guide:addWhy', { id: guide.id, revision: polished.revision }), /no Work Map/)
  const enter = polished.steps.find((s) => s.kind === 'enter')!
  const map: WorkMap = { id: 'wm-s-9', role: 'r', expert: 'Sabine', status: 'confirmed', guide: guide.id, open_questions: [], teachback: { confirmed: true, corrections: [] },
    steps: [{ id: 's1', index: 1, title: 'Code', guide_steps: [enter.id], t_start: 3, t_end: 4, decision: '6100 → 0400', reason: { text: 'Equipment over 5,000 is capex.', t: 5 }, judgment_call: true,
      guardrails: [{ id: 'g1', type: 'stop_and_ask', rule: 'Ask before capex without an asset number', quote: 'No asset number, no capex.', t: 6, source: 'debrief' }] }] }
  await getStore(h.ctx).write(['workmaps', 'wm-s-9.json'], map)
  const why = await h.invoke<Guide>('guide:addWhy', { id: guide.id, revision: polished.revision })
  const step = why.steps.find((s) => s.id === enter.id)!
  assert.equal(step.quote?.text, 'Equipment over 5,000 is capex.')
  assert.match(step.note, /Guardrail \(stop and ask\): Ask before capex without an asset number — “No asset number, no capex.”/)

  const html = await h.invoke<{ canceled: boolean; path: string }>('guide:exportHtml', { id: guide.id })
  assert.ok((await readFile(html.path, 'utf8')).includes('Equipment over 5,000 is capex.'))
  const md = await h.invoke<{ canceled: boolean; path: string }>('guide:exportMarkdown', { id: guide.id })
  const text = await readFile(md.path, 'utf8')
  assert.match(text, /^# /)
  assert.match(text, /!\[Step \d+\]\(images\/step-0\d\.jpg\)/)
  assert.match(text, /> “Equipment over 5,000 is capex.”/)
  assert.ok(md.path.startsWith(out))
  const image = text.match(/images\/(step-\d+\.jpg)/)![1]
  assert.deepEqual([...await readFile(path.join(path.dirname(md.path), 'images', image))].slice(0, 3), [255, 216, 255])
})

test('markdown leaves out hidden screenshots', () => {
  const guide: Guide = { id: 'g', title: 'T', app: 'a', session: 's', steps: [{ id: 'x', n: 1, t: 1, kind: 'click', title: 'Click Post', note: '', target: 'Post', shot: 's.jpg', highlight: null, blur: [], screen_moment: 'Invoice list', edited: false }] }
  const text = guideMarkdown(guide, new Map())
  assert.ok(!text.includes('!['))
  assert.match(text, /_Invoice list_/)
})
