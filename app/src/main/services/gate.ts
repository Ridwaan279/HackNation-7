// Natural-pause gate (PLAN §5.3): decides when the Interviewer may ask, keeps it quiet while the
// expert is busy, and feeds meaningful screen events to the agent as contextual updates.
import type { AppContext, PickedQuestion, ServiceInit, SidecarEvent } from '@shared/contracts'
import type { AgentCommand, AgentStatus } from '../../common/ipc'

const envNum = (name: string, dflt: number) => {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v > 0 ? v : dflt
}

// PLAN says ~1 question per 90 s, but M1 needs ≥3 questions in a 3-minute task, so default to 45 s.
const MIN_GAP_S = envNum('GATE_MIN_GAP_S', 45)
const MAX_PER_10_MIN = 5
const IDLE_S = 3
/** After a new screen opens the expert is probably reading. */
const READING_IDLE_S = 8
const FIRST_QUESTION_AFTER_S = 15
/** The pause must follow an action that finished recently. */
const ACTION_FRESH_S = 30
const SPEECH_GRACE_S = 2.5
const ACTIVITY_EVERY_S = 1
/** When the picker says "nothing worth asking", try again this much later. */
const RETRY_AFTER_NULL_S = 15

const FALLBACK_QUESTION =
  'Ask ONE short question about why the expert just did what they did on screen. ' +
  'If you have already asked about reasons twice, ask about a rule or limit they never break instead.'

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
let lastActivitySent = 0
let asked: number[] = []
let lastWindow = ''

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

function busy(t: number) {
  lastInput = t
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
    default:
      return null
  }
}

function onObserver(e: SidecarEvent) {
  const t = now()
  switch (e.type) {
    case 'activity':
      busy(t)
      return
    case 'click':
    case 'commit':
    case 'key':
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
  if (agent.userSpeaking) lastUserSpeech = t

  if (t - session.startedAt < FIRST_QUESTION_AFTER_S) return
  if (lastAction <= lastNudge || t - lastAction > ACTION_FRESH_S) return
  const idleNeeded = lastScreen >= lastInput - 0.5 ? READING_IDLE_S : IDLE_S
  if (t - lastInput < idleNeeded) return
  if (t - lastAgentSpeech < SPEECH_GRACE_S || t - lastUserSpeech < SPEECH_GRACE_S) return
  if (t - lastNudge < MIN_GAP_S) return
  asked = asked.filter((x) => t - x < 600)
  if (asked.length >= MAX_PER_10_MIN) return

  picking = true
  const sessionId = session.id
  try {
    let text: string
    try {
      const q = await ctx.bus.request('brain:pickQuestion', { session: sessionId })
      if (!q) {
        lastNudge = t - MIN_GAP_S + RETRY_AFTER_NULL_S
        return
      }
      lastPicked = q
      text = `Ask ONE short question: ${q.question}`
    } catch {
      // Agent C's picker isn't loaded yet: let the agent pick from what it has seen.
      lastPicked = null
      text = FALLBACK_QUESTION
    }
    // Things may have changed while the picker was thinking.
    if (!session || session.id !== sessionId || lastInput > t || agent.mode === 'speaking' || !agentLive()) return
    const nudge = `[pause] ${text}`
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
    lastNudge = lastAction = lastInput = lastScreen = 0
    asked = []
    lastPicked = null
  })
  c.bus.on('session:stopped', ({ id }) => {
    if (session?.id === id) session = null
  })
  c.bus.on('observer:event', onObserver)
  c.bus.on('transcript:line', (l) => {
    if (l.role === 'expert' || l.role === 'newhire') lastUserSpeech = now()
  })
  c.handle('agent:status', (s: Partial<AgentStatus>) => {
    agent = { ...agent, ...s }
    if (agent.mode === 'speaking') lastAgentSpeech = now()
    if (s.userSpeaking) lastUserSpeech = now()
  })
  setInterval(() => void tick(), 500)
}
