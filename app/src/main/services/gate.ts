// Natural-pause gate (PLAN §5.3): decides when the Interviewer may ask, keeps it quiet while the
// expert is busy, and feeds meaningful screen events to the agent as contextual updates.
import type { AppContext, PickedQuestion, ServiceInit, SidecarEvent } from '@shared/contracts'
import type { AgentCommand, AgentStatus } from '../../common/ipc'
import { getSettings } from './settings'

const envNum = (name: string, dflt: number) => {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v > 0 ? v : dflt
}

// Ask often: at least one question every ~20 s of pauses, up to 15 per 10 minutes (tunable in .env).
const MIN_GAP_S = envNum('GATE_MIN_GAP_S', 20)
const MAX_PER_10_MIN = envNum('GATE_MAX_PER_10_MIN', 15)
const IDLE_S = 3
/** No mouse, keyboard or speech for this long: use the quiet moment to ask, even without a fresh action. */
const IDLE_ASK_S = envNum('GATE_IDLE_ASK_S', 6)
/** Idle questions in a row without any input in between (so it doesn't nag someone who walked away). */
const MAX_IDLE_QUESTIONS = 2
/** After a new screen opens the expert is probably reading. */
const READING_IDLE_S = 8
const FIRST_QUESTION_AFTER_S = 10
/** Let the expert introduce the task first: no question until they have been talking or working this long. */
const WARMUP_S = envNum('GATE_WARMUP_S', 10)
/** Sent once when the Interviewer connects, so it listens to the introduction instead of interrupting it. */
const LISTEN_FIRST =
  'The expert is about to start. They will usually begin by explaining what they are going to show. ' +
  'Listen and call skip_turn; do not ask anything until you receive a [pause] message.'
/** The pause must follow an action that finished recently. */
const ACTION_FRESH_S = 30
const SPEECH_GRACE_S = 2.5
const ACTIVITY_EVERY_S = 1
/** When the picker says "nothing worth asking", try again this much later. */
const RETRY_AFTER_NULL_S = 15

const FALLBACK_QUESTION =
  'Ask ONE short question about why the expert just did what they did on screen. ' +
  'If you have already asked about reasons twice, ask about a rule or limit they never break instead.'

/** Every question opens politely, so it feels like a colleague leaning over, not a quiz. */
const INTERJECT = 'Politely interject: start with "Excuse me, could I ask something about this?" and then, in the same turn, '
/** How often the agent gets a quiet summary of the latest steps while recording. */
const SUMMARY_EVERY_S = 30

const IDLE_QUESTION =
  'Ask ONE short question (the user has paused) about what is on screen right now or what they did last: ' +
  'why they do it that way, what they check before moving on, or a rule they never break. Do not repeat an earlier question.'

let ctx: AppContext
let session: { id: string; kind: string; startedAt: number } | null = null
let agent: AgentStatus = { status: 'disconnected', mode: 'listening', agent: null }
let offRecord = false
let picking = false

let lastInput = 0
let lastAction = 0
let lastScreen = 0
let lastUserSpeech = 0
let lastAgentSpeech = 0
let lastNudge = 0
/** Idle questions asked since the last input. */
let idleAsks = 0
let latestSteps: string[] = []
let lastSummary = ''
let lastActivitySent = 0
let asked: number[] = []
let lastWindow = ''
/** When the expert first spoke or did something in this session (0 = not yet). */
let firstActivity = 0
let toldToListen = false

/** The question most recently put to the agent; used to fill related_event_t on answers. */
export let lastPicked: PickedQuestion | null = null

export function setOffRecord(value: boolean) {
  offRecord = value
}

const now = () => Date.now() / 1000
const send = (cmd: AgentCommand) => ctx.broadcast('agent:command', cmd)
const agentLive = () => !!session && agent.status === 'connected' && !offRecord

function feed(text: string) {
  if (agentLive()) send({ op: 'context', text })
}

function started(t: number) {
  if (session && !firstActivity) firstActivity = t
}

function busy(t: number) {
  lastInput = t
  started(t)
  idleAsks = 0
  if (agentLive() && t - lastActivitySent >= ACTIVITY_EVERY_S) {
    lastActivitySent = t
    send({ op: 'activity' })
  }
}

function describe(e: SidecarEvent): string | null {
  switch (e.type) {
    case 'click':
      return e.target?.name
        ? `User clicked ${e.target.control_type} "${e.target.name}".`
        : 'User clicked an unnamed spot on screen.'
    case 'commit':
      return e.masked
        ? `User changed field "${e.field}" (value masked for privacy).`
        : `User changed field "${e.field}" from "${e.old}" to "${e.new}".`
    case 'key':
      return e.key === 'ctrl+s' ? 'User pressed Ctrl+S (save).' : e.key === 'enter' ? 'User pressed Enter.' : null
    case 'context':
      return `User is now in ${e.app}: "${e.title}".`
    case 'blocked':
      return 'User switched to a private window. Not watching it; do not ask about it.'
    case 'selection':
      return `User highlighted: "${e.text.slice(0, 200)}".`
    default:
      return null
  }
}

function onObserver(e: SidecarEvent) {
  const t = now()
  switch (e.type) {
    case 'activity':
      // Typing keeps the ghost quiet; moving the mouse or scrolling does not (it may jump in then).
      if (e.kind === 'typing') busy(t)
      return
    case 'click':
    case 'commit':
    case 'key':
    case 'selection':
      busy(t)
      lastAction = t
      break
    case 'context': {
      const win = `${e.hwnd}|${e.title}`
      if (win === lastWindow) return
      lastWindow = win
      lastScreen = lastAction = t
      break
    }
    case 'blocked':
      if (lastWindow === 'blocked') return
      lastWindow = 'blocked'
      break
    default:
      return
  }
  const text = describe(e)
  if (text) feed(text)
}

async function tick() {
  if (!session || session.kind !== 'teach' || picking || !agentLive()) return
  const t = now()
  if (agent.mode === 'speaking') lastAgentSpeech = t
  if (agent.userSpeaking) {
    lastUserSpeech = t
    started(t)
  }

  if (t - session.startedAt < FIRST_QUESTION_AFTER_S) return
  // Wait for the expert to start explaining, then give the introduction time before the first question.
  if (!firstActivity || (!asked.length && t - firstActivity < WARMUP_S)) return
  if (t - lastAgentSpeech < SPEECH_GRACE_S || t - lastUserSpeech < SPEECH_GRACE_S) return
  if (t - lastNudge < MIN_GAP_S) return
  asked = asked.filter((x) => t - x < 600)
  if (asked.length >= MAX_PER_10_MIN) return

  const sinceInput = t - lastInput
  // 1. A natural pause right after an action (3 s, or 8 s when a new screen just opened).
  const idleNeeded = lastScreen >= lastInput - 0.5 ? READING_IDLE_S : IDLE_S
  const afterAction = lastAction > lastNudge && t - lastAction <= ACTION_FRESH_S && sinceInput >= idleNeeded
  // 2. Nothing is happening at all: no mouse, keyboard or speech.
  const idle = sinceInput >= IDLE_ASK_S && t - lastUserSpeech >= IDLE_ASK_S && idleAsks < MAX_IDLE_QUESTIONS
  if (!afterAction && !idle) return

  picking = true
  const sessionId = session.id
  try {
    let text: string
    try {
      const q = await ctx.bus.request('brain:pickQuestion', { session: sessionId })
      if (q) {
        lastPicked = q
        text = `${INTERJECT}ask ONE short question: ${q.question}`
      } else if (idle) {
        // Nothing specific to ask about, but the expert is idle: ask about the screen in general.
        lastPicked = null
        text = INTERJECT + IDLE_QUESTION.charAt(0).toLowerCase() + IDLE_QUESTION.slice(1)
      } else {
        lastNudge = t - MIN_GAP_S + RETRY_AFTER_NULL_S
        return
      }
    } catch {
      // Agent C's picker isn't loaded yet: let the agent pick from what it has seen.
      lastPicked = null
      text = INTERJECT + FALLBACK_QUESTION.charAt(0).toLowerCase() + FALLBACK_QUESTION.slice(1)
    }
    // Things may have changed while the picker was thinking.
    if (!session || session.id !== sessionId || lastInput > t || agent.mode === 'speaking' || !agentLive()) return
    const nudge = `[pause] ${text}`
    if (!afterAction) idleAsks++
    lastNudge = now()
    asked.push(lastNudge)
    send({ op: 'nudge', text: nudge })
    ctx.bus.emit('transcript:line', { session: sessionId, t: lastNudge, role: 'nudge', text: nudge })
  } finally {
    picking = false
  }
}

export const init: ServiceInit = (c) => {
  ctx = c
  c.bus.on('session:started', ({ id, kind }) => {
    session = { id, kind, startedAt: now() }
    lastNudge = lastAction = lastScreen = 0
    // Idle time counts from the start of the session.
    lastInput = now()
    idleAsks = 0
    firstActivity = 0
    toldToListen = false
    latestSteps = []
    lastSummary = ''
    asked = []
    lastPicked = null
  })
  c.bus.on('session:stopped', ({ id }) => {
    if (session?.id === id) session = null
  })
  c.bus.on('observer:event', onObserver)
  c.bus.on('transcript:line', (l) => {
    if (l.role !== 'expert' && l.role !== 'newhire') return
    lastUserSpeech = now()
    started(lastUserSpeech)
  })
  c.handle('agent:status', (s: Partial<AgentStatus>) => {
    agent = { ...agent, ...s }
    if (agent.mode === 'speaking') lastAgentSpeech = now()
    if (s.userSpeaking) {
      lastUserSpeech = now()
      started(lastUserSpeech)
    }
    if (session?.kind === 'teach' && !toldToListen && agentLive()) {
      toldToListen = true
      const teaching = getSettings().teaching
      send({ op: 'context', text: teaching ? `${LISTEN_FIRST} Today they are teaching: ${teaching}.` : LISTEN_FIRST })
    }
  })
  // Keep the agent up to date on what is being shown, without making it speak.
  c.bus.on('guide:updated', (g) => {
    if (session && g.session === session.id) latestSteps = g.steps.slice(-5).map((st) => `${st.n}. ${st.title}`)
  })
  setInterval(() => {
    if (!session || session.kind !== 'teach' || !agentLive() || !latestSteps.length) return
    const summary = latestSteps.join('; ')
    if (summary === lastSummary) return
    lastSummary = summary
    send({ op: 'context', text: `Latest steps the user has shown: ${summary}. If something does not add up, ask about it at the next [pause].` })
  }, SUMMARY_EVERY_S * 1000)
  setInterval(() => void tick(), 500)
}
