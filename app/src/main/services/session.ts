// Session lifecycle (teach / quick guide / tutor), the debrief hand-off, agent client tools,
// redacted transcripts, off-the-record, and the ghost's state + badge.
import { app, screen } from 'electron'
import type {
  Answer,
  AppContext,
  BlockReason,
  BusEvents,
  GhostState,
  Guide,
  Mode,
  Rect,
  ServiceInit,
  Violation,
  WorkMap,
} from '@shared/contracts'
import type {
  AgentCommand,
  AgentKind,
  AgentMessage,
  AgentToolCall,
  GhostPoint,
  ReplayCommand,
  SessionKind,
  SessionState,
} from '../../common/ipc'
import { lastPicked, setOffRecord as gateOffRecord } from './gate'
import { getSettings } from './settings'
import { showPanel, toOverlayLocal } from './windows'

const ROLE = () => getSettings().role
const EXPERT = () => getSettings().expert
/** Give the agent time to finish its goodbye before hanging up. */
const HANGUP_AFTER_MS = 8000
const ALERT_MS = 8000
const PROMPT_BUDGET = 6000

let ctx: AppContext
const state: SessionState = { id: null, kind: null, phase: 'idle', started_at: null, offRecord: false, agent: null }
let observerMode: Mode = 'ambient'
let blocked: BlockReason | null = null
let vision = false
let alertUntil = 0
let lastCommitRect: Rect | null = null
/** Guide ids seen per session, to match the Work Map draft to the session that produced it. */
const guideOf = new Map<string, string>()
let debriefWorkmap: WorkMap | null = null
let lastGhost = ''

const now = () => Date.now() / 1000
const send = (cmd: AgentCommand) => ctx.broadcast('agent:command', cmd)
const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v))

function publish() {
  ctx.broadcast('session:state', { ...state })
  publishGhost()
}

function publishGhost() {
  let ghost: GhostState = 'idle'
  if (Date.now() < alertUntil) ghost = 'alert'
  else if (state.offRecord || blocked) ghost = 'not_watching'
  else if (state.phase === 'debrief_pending') ghost = 'thinking'
  const recording = state.phase === 'live' && state.kind !== 'tutor'
  const badge = recording ? 'recording' : vision ? 'vision' : null
  const key = `${ghost}|${badge}`
  if (key === lastGhost) return
  lastGhost = key
  ctx.bus.emit('ghost:state', { state: ghost, badge })
}

// ------------------------------------------------------------------ helpers

/** Off the record always wins: the sidecar stays paused until it's switched back. */
async function setObserverMode(value: Mode) {
  observerMode = value
  await sendObserverMode(state.offRecord ? 'paused' : value)
}

async function sendObserverMode(value: Mode) {
  try {
    await ctx.bus.request('observer:mode', { value })
  } catch (err) {
    console.warn(`[session] observer:mode ${value} failed:`, (err as Error).message)
  }
}

/** Last-resort masking when the sidecar's redactor isn't available. Deliberately over-eager. */
function fallbackRedact(text: string) {
  return text
    .replace(/\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}\b/g, '[IBAN]')
    .replace(/\b(?:\d[ -]?){12,19}\b/g, '[NUMBER]')
    .replace(/\b(?:sk-[\w-]{10,}|AKIA[0-9A-Z]{16}|ghp_\w{20,}|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g, '[SECRET]')
}

async function redact(text: string) {
  if (!text) return text
  try {
    return (await ctx.bus.request('observer:redact', { text })).text
  } catch {
    return fallbackRedact(text)
  }
}

async function toDip(rect: Rect): Promise<Rect> {
  try {
    return (await ctx.bus.request('displays:toDip', { rect })).rect
  } catch {
    // Agent A's displays.ts not loaded: same conversion it will do.
    const r = screen.screenToDipRect(null, { x: rect[0], y: rect[1], width: rect[2] - rect[0], height: rect[3] - rect[1] })
    return [r.x, r.y, r.x + r.width, r.y + r.height]
  }
}

/** Physical-pixel rect -> the ghost flies there. */
export async function pointAtRect(rect: Rect, label?: string, ms?: number) {
  const point: GhostPoint = { rect: toOverlayLocal(await toDip(rect)), label, ms }
  ctx.broadcast('ghost:point', point)
}

function clip(text: string, max = PROMPT_BUDGET) {
  return text.length > max ? `${text.slice(0, max)}\n…(truncated)` : text
}

function workmapText(wm: WorkMap) {
  return clip(
    wm.steps
      .map((s) => {
        const rails = s.guardrails.map((g) => `   - [${g.type}] ${g.rule} ("${g.quote}")`).join('\n')
        return `${s.index}. ${s.title} (step_id ${s.id})\n   Decision: ${s.decision}\n   Why: "${s.reason.text}"${rails ? `\n   Guardrails:\n${rails}` : ''}`
      })
      .join('\n')
  )
}

function guideText(g: Guide | null) {
  if (!g) return '(no guide)'
  return clip(g.steps.map((s) => `${s.n}. ${s.title}`).join('\n'), 3000)
}

function baseVariables(): Record<string, string> {
  return { role: ROLE(), expert_name: EXPERT(), open_questions: '', draft_summary: '', workmap: '', guide: '' }
}

function startAgent(agent: AgentKind, session: string, vars: Record<string, string> = {}) {
  state.agent = agent
  send({ op: 'start', agent, session, dynamicVariables: { ...baseVariables(), ...vars } })
}

function stopAgent() {
  if (!state.agent) return
  state.agent = null
  send({ op: 'stop' })
}

function reset() {
  Object.assign(state, { id: null, kind: null, phase: 'idle', started_at: null, workmap_id: undefined, agent: null })
  debriefWorkmap = null
}

// ---------------------------------------------------------------- lifecycle

export async function startSession(kind: SessionKind, workmap_id?: string) {
  if (state.id) await stopSession()
  const id = `s-${new Date().toISOString().replace(/[:.]/g, '-')}`
  Object.assign(state, { id, kind, phase: 'live', started_at: now(), workmap_id, agent: null })
  await setObserverMode(kind === 'tutor' ? 'tutor' : 'session')
  ctx.bus.emit('session:started', { id, kind, workmap_id })
  if (kind === 'teach') startAgent('interviewer', id)
  if (kind === 'tutor') startAgent('tutor', id, await tutorVariables(workmap_id))
  publish()
  return { ...state }
}

export async function stopSession() {
  const { id, kind, phase } = state
  if (!id) return { ...state }
  if (phase === 'debrief' || phase === 'debrief_pending') {
    // Stopping during the debrief abandons it.
    stopAgent()
    reset()
    publish()
    return { ...state }
  }
  stopAgent()
  ctx.bus.emit('session:stopped', { id })
  await setObserverMode('ambient')
  if (kind === 'teach') {
    // Wait for Agent C's draft Work Map (workmap:updated), then run the debrief.
    state.phase = 'debrief_pending'
  } else reset()
  publish()
  return { ...state }
}

export function isRecording() {
  return state.phase === 'live'
}

/** Any session or debrief in progress (no "teach me this app?" offers then). */
export function isBusy() {
  return state.phase !== 'idle'
}

function startDebrief(wm: WorkMap | null) {
  if (!state.id) return
  debriefWorkmap = wm
  state.phase = 'debrief'
  const open = wm?.open_questions ?? []
  startAgent('debrief', state.id, {
    open_questions: open.length ? open.map((q, i) => `${i + 1}. ${q}`).join('\n') : '(none listed: ask about exceptions and limits)',
    draft_summary: wm ? workmapText(wm) : '(draft not available)',
  })
  publish()
}

function onWorkmap(wm: WorkMap) {
  if (state.phase === 'debrief_pending' && wm.status === 'draft') {
    const guide = state.id ? guideOf.get(state.id) : undefined
    if (!guide || !wm.guide || wm.guide === guide) startDebrief(wm)
    return
  }
  if (state.phase === 'debrief' && debriefWorkmap?.id === wm.id) debriefWorkmap = wm
}

async function tutorVariables(workmap_id?: string): Promise<Record<string, string>> {
  if (!workmap_id) return { workmap: '(no Work Map selected)' }
  try {
    const wm = await ctx.bus.request('brain:workmap', { id: workmap_id })
    if (!wm) return { workmap: '(Work Map not found)' }
    const guide = wm.guide ? await ctx.bus.request('brain:guide', { id: wm.guide }).catch(() => null) : null
    return { workmap: workmapText(wm), guide: guideText(guide), expert_name: wm.expert || EXPERT(), role: wm.role || ROLE() }
  } catch (err) {
    console.warn('[session] could not load the Work Map for the tutor:', (err as Error).message)
    return { workmap: '(Work Map unavailable)' }
  }
}

export function isOffRecord() {
  return state.offRecord
}

export async function toggleOffRecord() {
  state.offRecord = !state.offRecord
  gateOffRecord(state.offRecord)
  await sendObserverMode(state.offRecord ? 'paused' : observerMode)
  if (state.agent) send({ op: 'mute', muted: state.offRecord })
  if (state.id) {
    const text = state.offRecord ? '[off the record]' : '[back on the record]'
    ctx.bus.emit('transcript:line', { session: state.id, t: now(), role: 'nudge', text })
  }
  publish()
  return { ...state }
}

// -------------------------------------------------------------- tutor bits

async function replay(step_id: string) {
  if (!state.workmap_id) return 'No Work Map loaded.'
  const steps = await ctx.bus.request('brain:stepsFor', { workmap_id: state.workmap_id, step_id }).catch(() => [])
  if (!steps.length) return `No screenshots for step ${step_id}.`
  const cmd: ReplayCommand = { step_id, steps }
  ctx.broadcast('panel:replay', cmd)
  showPanel()
  return `Showing ${EXPERT()}'s screenshots for that step.`
}

function onViolation(v: Violation) {
  if (state.kind !== 'tutor' || state.phase !== 'live' || v.session !== state.id) return
  alertUntil = Date.now() + ALERT_MS
  publishGhost()
  setTimeout(publishGhost, ALERT_MS + 50)
  send({
    op: 'nudge',
    text:
      `[intervene] The new hire just broke a guardrail: ${v.why} ` +
      `${EXPERT()}'s words: "${v.quote.text}". Stop them before they post. ` +
      `Say "${EXPERT()} would stop here. Why do you think?" and explain using ${EXPERT()}'s reasoning.`,
  })
  const field = v.rect ?? lastCommitRect
  if (field) void pointAtRect(field, 'Check this field', ALERT_MS)
  void replay(v.step_id)
}

// ----------------------------------------------------------- agent → main

async function onTool({ name, args }: AgentToolCall): Promise<string> {
  const session = state.id
  if (!session) return 'No active session.'
  switch (name) {
    case 'record_answer': {
      const type = ['reason', 'guardrail', 'exception'].includes(str(args.type)) ? (str(args.type) as Answer['type']) : 'reason'
      const related = Number(args.related_event_t)
      ctx.bus.emit('agent:answer', {
        session,
        t: now(),
        question: await redact(str(args.question)),
        answer_quote: await redact(str(args.answer_quote)),
        type,
        related_event_t: Number.isFinite(related) && related > 0 ? related : lastPicked?.about_event_t,
        source: state.phase === 'debrief' ? 'debrief' : 'live',
      })
      return 'Saved.'
    }
    case 'record_correction':
      ctx.bus.emit('agent:correction', {
        session,
        step_id: str(args.step_id),
        correction_quote: await redact(str(args.correction_quote)),
      })
      return 'Correction saved.'
    case 'teachback_confirmed':
      ctx.bus.emit('agent:teachback_confirmed', { session, t: now() })
      setTimeout(() => {
        if (state.id === session && state.phase === 'debrief') {
          stopAgent()
          reset()
          publish()
        }
      }, HANGUP_AFTER_MS)
      return 'Confirmed. Thank the expert in one sentence and say goodbye.'
    case 'point_at': {
      const target = str(args.target)
      const loc = await ctx.bus.request('brain:locate', { target }).catch(() => null)
      if (!loc) return `I couldn't find "${target}" on screen. Describe where it usually is instead.`
      await pointAtRect(loc.rect, target)
      return `Pointing at ${target} now.`
    }
    case 'replay_moment':
      return replay(str(args.step_id))
    case 'mark_step': {
      const outcome = ['alone', 'hint', 'caught'].includes(str(args.outcome))
        ? (str(args.outcome) as BusEvents['tutor:mark_step']['outcome'])
        : 'hint'
      ctx.bus.emit('tutor:mark_step', { session, step_id: str(args.step_id), outcome })
      return 'Noted.'
    }
    default:
      return `Unknown tool "${name}".`
  }
}

async function onMessage({ role, text }: AgentMessage) {
  const session = state.id
  if (!session || state.offRecord || !text.trim()) return
  const speaker = role === 'agent' ? 'agent' : state.kind === 'tutor' ? 'newhire' : 'expert'
  ctx.bus.emit('transcript:line', { session, t: now(), role: speaker, text: await redact(text) })
}

// --------------------------------------------------------------------- init

export const init: ServiceInit = (c) => {
  ctx = c
  c.handle('session:start', (p: { kind?: SessionKind; workmap_id?: string } = {}) =>
    startSession(p.kind ?? 'teach', p.workmap_id)
  )
  c.handle('session:stop', () => stopSession())
  c.handle('session:state', () => ({ ...state }))
  c.handle('session:offRecord', () => toggleOffRecord())
  c.handle('debrief:start', () => {
    if (state.phase === 'debrief_pending') startDebrief(null)
    return { ...state }
  })
  c.handle('agent:tool', (call: AgentToolCall) => onTool(call))
  c.handle('agent:message', (m: AgentMessage) => onMessage(m))
  // Voice-agent diagnostics (which mic, connection errors) in the `npm run dev` terminal.
  c.handle('agent:log', (p: { message: string }) => console.log(`[agent] ${String(p?.message).slice(0, 300)}`))
  c.handle('popup:answer', (a: { id: string; choice: string }) => c.bus.emit('popup:answer', a))

  // Dev bench (DevDashboard): emit any bus event, point at a physical rect.
  if (!app.isPackaged) {
    c.handle('dev:emit', (p: { name: keyof BusEvents; payload: any }) => c.bus.emit(p.name, p.payload))
    c.handle('dev:point', (p: { rect: Rect; label?: string }) => pointAtRect(p.rect, p.label))
  }

  c.bus.on('guide:updated', (g) => {
    if (g.session) guideOf.set(g.session, g.id)
  })
  c.bus.on('workmap:updated', onWorkmap)
  c.bus.on('tutor:violation', onViolation)
  c.bus.on('observer:event', (e) => {
    if (e.type === 'blocked') blocked = e.reason
    else if (e.type === 'context') {
      blocked = null
      vision = e.capture === 'vision'
    } else if (e.type === 'commit' && e.rect) lastCommitRect = e.rect
    else return
    publishGhost()
  })
}
