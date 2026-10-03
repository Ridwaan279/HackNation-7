import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { z } from 'zod'
import type { AppContext, ContextEvent, Guide, GuideEdit, GuideStep, PickedQuestion, ServiceInit, SidecarEvent } from '@shared/contracts'
import { getStore } from './store'
import { getLlm, readPrompt } from './llm'
import { getDescriber, screenshotData, shotStorage } from './describe'

const clone = <T>(value: T): T => structuredClone(value)
const normal = (text: string) => text.trim().toLowerCase()
const idSchema = z.string().min(1).max(160).regex(/^[a-zA-Z0-9_-]+$/)
const textSchema = z.string().max(4000)
const stepEditSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('rename'), title: z.string().trim().min(1).max(200) }).strict(),
  z.object({ kind: z.literal('edit'), step_id: idSchema, title: z.string().trim().min(1).max(300), note: textSchema }).strict(),
  z.object({ kind: z.enum(['delete', 'merge', 'hide']), step_id: idSchema }).strict(),
  z.object({ kind: z.literal('move'), step_id: idSchema, direction: z.enum(['up', 'down']) }).strict(),
  z.object({ kind: z.literal('note'), after_id: idSchema.optional(), note: textSchema }).strict(),
])
const saveSchema = z.object({ id: idSchema, revision: z.number().int().nonnegative(), edit: stepEditSchema }).strict()
const imageRequest = z.object({ id: idSchema, step_id: idSchema }).strict()
const rectSchema = z.tuple([z.number().nonnegative(), z.number().nonnegative(), z.number().positive(), z.number().positive()])
const blurSchema = imageRequest.extend({ revision: z.number().int().nonnegative(), data_url: z.string().max(7_000_000), regions: z.array(rectSchema).min(1).max(50) }).strict()
const questionSchema = z.object({ question: z.string().min(1).max(240), type: z.enum(['reason', 'guardrail', 'exception']), about_event_t: z.number() }).strict().nullable()

function newStep(t: number, kind: GuideStep['kind'], title: string, target = ''): GuideStep {
  return { id: randomUUID(), n: 0, t, kind, title, note: '', target, shot: null, highlight: null, blur: [], screen_moment: '', edited: false }
}

/** Synchronous reducer: timestamps are seconds, geometry stays in physical pixels. */
export class CaptureSession {
  readonly guide: Guide
  context: ContextEvent | null = null
  blocked = true
  readonly events: SidecarEvent[] = []
  readonly eventSteps = new Map<number, string>()
  private lastClick: { identity: string; t: number; step: string } | null = null
  private pendingFields = new Map<string, string>()
  constructor(id: string, readonly kind: 'teach' | 'quick_guide') {
    this.guide = { id: `guide-${id}`, session: id, title: 'Untitled guide', app: '', steps: [], revision: 0, recording: true, app_keys: [] }
  }
  push(event: SidecarEvent): boolean {
    if (event.type === 'blocked') { this.blocked = true; this.context = null; this.pendingFields.clear(); this.lastClick = null; return false }
    if (event.type === 'context') {
      const changed = !this.context || this.context.key !== event.key || this.context.title !== event.title
      this.context = event; this.blocked = false
      for (const key of [event.key, event.app]) if (!this.guide.app_keys!.includes(key)) this.guide.app_keys!.push(key)
      if (!this.guide.app) { this.guide.app = event.key; this.guide.title = `${event.title} guide` }
      if (!changed) return false
      this.events.length = 0
      this.pendingFields.clear(); this.lastClick = null
      this.add({ ...newStep(event.t, 'switch', `Switch to ${event.title || event.app}`, event.app), app_key: event.key })
      return true
    }
    if (this.blocked || !this.context) return false
    if (['click', 'commit', 'text'].includes(event.type)) {
      this.events.push(event)
      if (this.events.length > 200) this.events.shift()
    }
    if (event.type === 'click') {
      const name = event.target?.name.trim() || 'unnamed control'
      const control = event.target?.control_type.toLowerCase() ?? ''
      const identity = `${this.context.key}|${event.target?.automation_id}|${name}|${event.target?.rect.join(',')}`
      const previous = this.lastClick && this.guide.steps.find((step) => step.id === this.lastClick!.step)
      if (event.target && previous && this.lastClick!.identity === identity && event.t - this.lastClick!.t <= 1.5 && event.t >= this.lastClick!.t) {
        previous.title = `Double-click ${name}`
        this.eventSteps.set(event.t, previous.id)
        this.lastClick = null
        return true
      }
      const field = /edit|combobox/.test(control)
      const kind = /listitem|checkbox|radiobutton/.test(control) ? 'select' : 'click'
      const verb = /checkbox/.test(control) ? 'Check' : kind === 'select' ? 'Select' : 'Click'
      const step = { ...newStep(event.t, kind, `${verb} ${name}`, name), app_key: this.context.key, shot: event.shot, shot_meta: event.shot_meta ?? undefined, highlight: event.target?.rect_trusted ? event.target.rect : null }
      this.add(step)
      this.eventSteps.set(event.t, step.id)
      this.lastClick = { identity, t: event.t, step: step.id }
      if (field) this.pendingFields.set(normal(name), step.id)
      return true
    }
    if (event.type === 'commit') {
      if (event.old === event.new) return false
      const field = normal(event.field)
      let step = this.guide.steps.find((candidate) => candidate.id === this.pendingFields.get(field))
      if (!step) {
        step = { ...newStep(event.t, 'enter', '', event.field), app_key: this.context.key }
        this.add(step)
      }
      step.kind = 'enter'; step.value = event.new; step.title = `Enter ${event.new || '(empty)'} in ${event.field}`
      step.highlight = event.rect
      this.eventSteps.set(event.t, step.id)
      // Preserve the initial field click timestamp and screenshot when merging.
      this.pendingFields.set(field, step.id)
      if ('final' in event && event.final === true) this.pendingFields.delete(field)
      this.lastClick = null
      return true
    }
    if (event.type === 'key' && ['enter', 'ctrl+s', 'ctrl+enter'].includes(event.key)) {
      const step = [...this.guide.steps].reverse().find((candidate) => candidate.kind === 'enter')
      const latestCommit = [...this.events].reverse().find((candidate) => candidate.type === 'commit')
      if (step && latestCommit && event.t - latestCommit.t <= 2 && event.t >= latestCommit.t) {
        const note = `Confirm with ${event.key}.`
        if (!step.note.includes(note)) step.note = [step.note, note].filter(Boolean).join(' ')
        this.pendingFields.clear()
        return true
      }
    }
    if (event.type === 'shot' && !event.ephemeral && event.key === this.context.key) {
      const step = this.guide.steps.at(-1)
      if (step && !step.shot && event.t >= step.t && event.t - step.t <= 30) {
        step.shot = event.path; step.shot_meta = event.meta
        return true
      }
    }
    return false
  }
  private add(step: GuideStep): void { step.n = this.guide.steps.length + 1; this.guide.steps.push(step) }
}

export function editGuide(original: Guide, edit: GuideEdit): Guide {
  if (original.recording) throw new Error('Stop recording before editing this guide.')
  const guide = clone(original)
  if (edit.kind === 'rename') guide.title = edit.title
  else if (edit.kind === 'note') {
    const index = edit.after_id ? guide.steps.findIndex((step) => step.id === edit.after_id) : guide.steps.length - 1
    if (edit.after_id && index < 0) throw new Error('Step no longer exists.')
    guide.steps.splice(index + 1, 0, { ...newStep(guide.steps[index]?.t ?? 0, 'note', 'Note'), note: edit.note, edited: true })
  } else {
    const index = guide.steps.findIndex((step) => step.id === edit.step_id)
    if (index < 0) throw new Error('Step no longer exists.')
    const step = guide.steps[index]
    if (edit.kind === 'edit') { step.title = edit.title; step.note = edit.note; step.edited = true }
    if (edit.kind === 'delete') guide.steps.splice(index, 1)
    if (edit.kind === 'hide') { step.screenshot_hidden = !step.screenshot_hidden; step.edited = true }
    if (edit.kind === 'move') {
      const next = index + (edit.direction === 'up' ? -1 : 1)
      if (next < 0 || next >= guide.steps.length) throw new Error('Step is already at the end.')
      ;[guide.steps[index], guide.steps[next]] = [guide.steps[next], guide.steps[index]]
    }
    if (edit.kind === 'merge') {
      if (!index) throw new Error('The first step has no previous step.')
      const previous = guide.steps[index - 1]
      previous.note = [previous.note, step.title, step.note].filter(Boolean).join('\n')
      if (!previous.shot && step.shot) {
        previous.shot = step.shot; previous.shot_meta = step.shot_meta; previous.highlight = step.highlight
        previous.blur = step.blur; previous.screenshot_hidden = step.screenshot_hidden; previous.screen_moment = step.screen_moment
      }
      previous.edited = true
      guide.steps.splice(index, 1)
    }
  }
  guide.steps.forEach((step, index) => { step.n = index + 1 })
  return guide
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)
export async function guideHtml(ctx: AppContext, guide: Guide): Promise<string> {
  const steps = await Promise.all(guide.steps.map(async (step) => {
    let image = ''
    if (step.shot && !step.screenshot_hidden) {
      const shot = await screenshotData(ctx, step.shot)
      image = `<img alt="Step screenshot" src="data:${shot.media};base64,${shot.bytes.toString('base64')}">`
    }
    return `<section><h2>${step.n}. ${escapeHtml(step.title)}</h2><p>${escapeHtml(step.note)}</p>${image}<p>${escapeHtml(step.screen_moment)}</p>${step.quote ? `<blockquote>${escapeHtml(step.quote.text)}</blockquote>` : ''}</section>`
  }))
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><title>${escapeHtml(guide.title)}</title><style>body{font:14px Arial,sans-serif;color:#21372e;margin:35px}h1{font-size:28px}h2{font-size:18px}section{break-inside:avoid;margin:25px 0}img{max-width:100%;max-height:650px;object-fit:contain}p{white-space:pre-wrap}blockquote{border-left:3px solid #647d72;padding-left:15px}</style></head><body><h1>${escapeHtml(guide.title)}</h1><p>${escapeHtml(guide.app)}</p>${steps.join('')}</body></html>`
}

/** A temporary sandboxed window is used solely for Electron's native PDF renderer. */
export async function printGuidePdf(html: string): Promise<Buffer> {
  const { BrowserWindow } = await import('electron')
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false } })
  try {
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    return await window.webContents.printToPDF({ printBackground: true, pageSize: 'A4', preferCSSPageSize: true })
  } finally { window.destroy() }
}

export function createStepsService(ctx: AppContext, dependencies: {
  model?: ReturnType<typeof getLlm>
  describe?: ReturnType<typeof getDescriber>['describe']
  questionPrompt?: string
  exportPdf?: (html: string, title: string) => Promise<{ canceled: boolean; path?: string }>
} = {}) {
  const store = getStore(ctx)
  const guides = new Map<string, Guide>()
  let active: CaptureSession | null = null
  let latestContext: ContextEvent | null = null
  let serialized = Promise.resolve<unknown>(undefined)
  const described = new Set<string>()
  const asked = new Map<string, PickedQuestion[]>()
  const answered = new Map<string, number[]>()
  const picking = new Set<string>()
  const eventLinks = new Map<string, Map<number, string>>()
  const pending = new Set<Promise<unknown>>()
  const report = (area: string, message: string) => ctx.broadcast('brain:status', { area, message })
  function track(task: Promise<unknown>, area = 'guide'): void {
    pending.add(task)
    void task.catch(() => report(area, 'Unable to complete this operation. Check the observer, storage and model configuration.')).finally(() => pending.delete(task))
  }
  function queue<T>(operation: () => Promise<T>): Promise<T> {
    const result = serialized.catch(() => undefined).then(operation)
    serialized = result
    return result
  }
  async function load(id: string): Promise<Guide | null> {
    idSchema.parse(id)
    if (!guides.has(id)) {
      const saved = await store.read<Guide>(['guides', `${id}.json`])
      if (saved) { saved.recording = false; guides.set(id, saved) }
    }
    return guides.get(id) ?? null
  }
  async function list(): Promise<Guide[]> {
    for (const file of await store.list(['guides'])) if (file.endsWith('.json')) await load(file.slice(0, -5))
    return clone([...guides.values()].reverse())
  }
  async function publish(guide: Guide): Promise<void> {
    guide.revision = (guide.revision ?? 0) + 1
    guides.set(guide.id, guide)
    const snapshot = clone(guide)
    await store.write(['guides', `${guide.id}.json`], snapshot)
    ctx.bus.emit('guide:updated', snapshot)
    ctx.broadcast('guide:updated', snapshot)
  }
  async function checked(id: string, revision: number): Promise<Guide> {
    const guide = await load(id)
    if (!guide) throw new Error('Guide no longer exists.')
    if (guide.recording) throw new Error('Stop recording before editing this guide.')
    if ((guide.revision ?? 0) !== revision) throw new Error('Guide changed. Reload it before saving.')
    return guide
  }
  function describeSteps(guide: Guide): void {
    for (const step of guide.steps) {
      if (!step.shot || described.has(`${step.id}:${step.shot}`)) continue
      const filename = step.shot
      described.add(`${step.id}:${filename}`)
      track((async () => {
        const result = await (dependencies.describe ?? getDescriber(ctx).describe)({ path: filename, appKeys: guide.app_keys ?? [guide.app], target: step.target, t: step.t, ephemeral: false })
        if (!result) return
        await queue(async () => {
          const current = await load(guide.id)
          const target = current?.steps.find((candidate) => candidate.id === step.id)
          if (!current || !target || target.edited || target.shot !== filename) return
          target.screen_moment = result.screen_moment
          if (target.target === 'unnamed control' && result.target) { target.target = result.target; target.title = `Click ${result.target}` }
          await publish(current)
        })
      })(), 'description')
    }
  }

  ctx.bus.on('session:started', (event) => {
    if (active) { active.guide.recording = false; track(publish(active.guide)) }
    active = event.kind === 'tutor' ? null : new CaptureSession(idSchema.parse(event.id), event.kind)
    if (active) {
      eventLinks.set(event.id, active.eventSteps)
      if (latestContext) active.push(latestContext)
      track(publish(active.guide))
    }
  })
  ctx.bus.on('session:stopped', (event) => {
    if (active?.guide.session !== event.id) return
    active.guide.recording = false
    track(publish(active.guide)); active = null
  })
  ctx.bus.on('observer:event', (event) => {
    if (event.type === 'context') latestContext = event
    if (event.type === 'blocked') latestContext = null
    if (active?.push(event)) { track(publish(active.guide)); describeSteps(active.guide) }
  })
  ctx.bus.on('agent:answer', (answer) => {
    track(queue(async () => {
      const guide = [...guides.values()].find((candidate) => candidate.session === answer.session)
      if (!guide) return
      const question = (await ctx.bus.request('observer:redact', { text: answer.question })).text
      const quote = (await ctx.bus.request('observer:redact', { text: answer.answer_quote })).text
      await store.append(['sessions', answer.session, 'answers.jsonl'], { ...answer, question, answer_quote: quote })
      const times = answered.get(answer.session) ?? []
      if (answer.related_event_t !== undefined) times.push(answer.related_event_t)
      answered.set(answer.session, times)
      const linked = answer.related_event_t === undefined ? undefined : eventLinks.get(answer.session)?.get(answer.related_event_t)
      const step = guide.steps.find((candidate) => candidate.id === linked)
      if (step) { step.quote = { text: quote, t: answer.t, source: answer.source }; await publish(guide) }
    }), 'answer')
  })

  ctx.bus.handle('brain:guide', async ({ id }) => clone(await load(id)))
  ctx.bus.handle('brain:pickQuestion', async ({ session }) => {
    const capture = active
    if (!capture || capture.guide.session !== session || capture.kind !== 'teach' || capture.blocked || picking.has(session)) return null
    const previous = asked.get(session) ?? []
    const times = new Set([...previous.map((question) => question.about_event_t), ...(answered.get(session) ?? [])])
    const candidates = capture.events.filter((event) => !times.has(event.t) && (event.type === 'commit' && event.old !== event.new || event.type === 'click' && /hold|approv|post|rerout/i.test(event.target?.name ?? ''))).slice(-12)
    if (!candidates.length) return null
    picking.add(session)
    try {
      const guardrail = !previous.some((question) => question.type === 'guardrail')
      let result: PickedQuestion | null = null
      try {
        result = await (dependencies.model ?? getLlm(ctx)).fast({ appKeys: capture.guide.app_keys ?? [capture.guide.app], system: dependencies.questionPrompt ?? await readPrompt('question_picker'), input: JSON.stringify({ require_guardrail: guardrail, candidates, already_asked: previous }), schema: questionSchema })
        if (result && (!candidates.some((event) => event.t === result!.about_event_t) || guardrail && result.type !== 'guardrail')) result = null
      } catch {
        // Local, evidence-based fallback works without API access; never invent policy.
        const event = candidates.at(-1)!
        const target = event.type === 'commit' ? event.field : event.type === 'click' ? event.target!.name : ''
        result = { question: guardrail ? `What would make you stop and double-check ${target} here?` : `What made you choose this ${target} change?`, type: guardrail ? 'guardrail' : 'reason', about_event_t: event.t }
        report('question', 'Using a local question because model selection is unavailable.')
      }
      if (!result || active !== capture || capture.blocked) return null
      const question = (await ctx.bus.request('observer:redact', { text: result.question })).text
      if (active !== capture || capture.blocked || previous.some((item) => normal(item.question) === normal(question))) return null
      const picked = { ...result, question }
      asked.set(session, [...previous, picked])
      return picked
    } catch { report('question', 'Question withheld because redaction is unavailable.'); return null }
    finally { picking.delete(session) }
  })

  ctx.handle('guides:list', () => list())
  ctx.handle('guide:get', async (payload) => clone(await load(z.object({ id: idSchema }).strict().parse(payload).id)))
  ctx.handle('guide:save', (payload) => queue(async () => {
    const { id, revision, edit } = saveSchema.parse(payload)
    await checked(id, revision)
    // User-entered notes and titles follow the same masking boundary as voice.
    const safe = clone(edit)
    if ('title' in safe) safe.title = (await ctx.bus.request('observer:redact', { text: safe.title })).text
    if ('note' in safe) safe.note = (await ctx.bus.request('observer:redact', { text: safe.note })).text
    const guide = await checked(id, revision)
    const edited = editGuide(guide, safe)
    await publish(edited)
    return clone(edited)
  }))
  ctx.handle('guide:image', async (payload) => {
    const { id, step_id } = imageRequest.parse(payload)
    const step = (await load(id))?.steps.find((candidate) => candidate.id === step_id)
    if (!step?.shot || step.screenshot_hidden) return null
    const shot = await screenshotData(ctx, step.shot)
    return { data_url: `data:${shot.media};base64,${shot.bytes.toString('base64')}` }
  })
  ctx.handle('guide:blur', (payload) => queue(async () => {
    const { id, step_id, revision, data_url, regions } = blurSchema.parse(payload)
    const guide = await checked(id, revision)
    const step = guide.steps.find((candidate) => candidate.id === step_id)
    if (!step?.shot || step.screenshot_hidden) throw new Error('Screenshot is unavailable.')
    if (!/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(data_url)) throw new Error('Expected a flattened PNG image.')
    const { nativeImage } = await import('electron')
    const original = await screenshotData(ctx, step.shot)
    const source = nativeImage.createFromBuffer(original.bytes)
    const size = source.getSize()
    if (source.isEmpty() || size.width * size.height > 20_000_000) throw new Error('Screenshot is unavailable or too large.')
    if (regions.some(([left, top, right, bottom]) => right <= left || bottom <= top || right > size.width || bottom > size.height)) throw new Error('Blur region is outside the screenshot.')
    // The renderer only chooses regions. Paint them into the original bitmap
    // here, so a forged data URL cannot preserve pixels under a claimed mask.
    const pixels = source.toBitmap()
    for (const [left, top, right, bottom] of regions) {
      for (let y = Math.floor(top); y < Math.ceil(bottom); y++) {
        for (let x = Math.floor(left); x < Math.ceil(right); x++) {
          const offset = (y * size.width + x) * 4
          pixels[offset] = 67; pixels[offset + 1] = 75; pixels[offset + 2] = 52; pixels[offset + 3] = 255
        }
      }
    }
    const image = nativeImage.createFromBitmap(pixels, size)
    const originalPath = step.shot
    const nextPath = `shots/edited/${randomUUID()}.png`
    const storage = shotStorage(ctx, nextPath)
    await storage.store.writeBytes(storage.parts, image.toPNG())
    // Replace every reference, so another step cannot reopen the unblurred image.
    await list()
    for (const current of guides.values()) {
      let changed = false
      for (const candidate of current.steps) if (candidate.shot === originalPath) {
        candidate.shot = nextPath; candidate.blur = [...candidate.blur, ...regions]; candidate.edited = true; candidate.screen_moment = ''; changed = true
      }
      if (changed) await publish(current)
    }
    const old = shotStorage(ctx, originalPath)
    await old.store.remove(old.parts)
    return clone(guides.get(id)!)
  }))
  ctx.handle('guide:exportPdf', async (payload) => {
    const { id } = z.object({ id: idSchema }).strict().parse(payload)
    const guide = await load(id)
    if (!guide) throw new Error('Guide no longer exists.')
    if (guide.recording) throw new Error('Stop recording before exporting.')
    const snapshot = clone(guide)
    const html = await guideHtml(ctx, snapshot)
    if (dependencies.exportPdf) return dependencies.exportPdf(html, snapshot.title)
    const { dialog } = await import('electron')
    const result = await dialog.showSaveDialog({ title: 'Export guide as PDF', defaultPath: 'apprentice-guide.pdf', filters: [{ name: 'PDF', extensions: ['pdf'] }] })
    if (result.canceled || !result.filePath) return { canceled: true }
    await writeFile(result.filePath, await printGuidePdf(html))
    return { canceled: false, path: result.filePath }
  })
  return { list, drain: async () => { while (pending.size) await Promise.allSettled([...pending]); await serialized.catch(() => undefined) } }
}

export const init: ServiceInit = (ctx) => { createStepsService(ctx) }
