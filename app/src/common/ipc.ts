// Agent B's renderer <-> main IPC payloads (types only).
// Cross-agent data lives in shared/contracts.ts; these are the shell's own channels.
//
// renderer -> main (invoke):
//   session:start {kind, workmap_id?}   session:stop   session:state -> SessionState
//   session:offRecord -> SessionState   debrief:start (start the debrief now, without waiting for the draft)
//   agent:auth {agent} -> AgentAuth     agent:status AgentStatus    agent:message AgentMessage
//   agent:tool AgentToolCall -> string  tts:speak {text} -> TtsResult
//   popup:answer {id, choice}           overlay:setInteractive boolean   overlay:geometry -> OverlayGeometry
//   panel:toggle   panel:show (legacy aliases for dashboard)   dashboard:open {path?}   ghost:menu   app:quit
//
// main -> windows (broadcast): agent:command, ghost:point, panel:replay (dashboard), session:state, overlay:geometry,
//   plus these bus events forwarded verbatim: guide:updated, workmap:updated, profile:updated,
//   tutor:violation, popup:show, ghost:state, session:started, session:stopped, transcript:line,
//   agent:answer, observer:event (all except activity and text).

import type { GuideStep, Rect } from '@shared/contracts'

export type AgentKind = 'interviewer' | 'debrief' | 'tutor' | 'assistant'
export type SessionKind = 'teach' | 'quick_guide' | 'tutor'

/** main -> overlay on 'agent:command'. The overlay owns the ElevenLabs conversation. */
export type AgentCommand =
  | { op: 'start'; agent: AgentKind; session: string; dynamicVariables: Record<string, string>; firstMessage?: string; prompt?: string }
  | { op: 'stop' }
  | { op: 'nudge'; text: string }
  | { op: 'context'; text: string }
  | { op: 'activity' }
  | { op: 'mute'; muted: boolean }

export interface AgentAuth {
  conversationToken?: string
  agentId?: string
  error?: string
}

/** overlay -> main on 'agent:status'. Partial updates are merged. */
export interface AgentStatus {
  status: 'disconnected' | 'connecting' | 'connected' | 'disconnecting'
  mode: 'speaking' | 'listening'
  agent: AgentKind | null
  /** true while voice activity is detected on the mic. */
  userSpeaking?: boolean
}

export interface AgentMessage {
  role: 'user' | 'agent'
  text: string
}

export interface AgentToolCall {
  name: string
  args: Record<string, unknown>
}

export type TtsResult = { audio: string; mime: string } | { error: string }

export interface SessionState {
  id: string | null
  kind: SessionKind | null
  /** live = the session is recording; debrief = recording stopped, debrief agent running or pending. */
  phase: 'idle' | 'live' | 'debrief_pending' | 'debrief'
  started_at: number | null
  workmap_id?: string
  task?: string
  offRecord: boolean
  agent: AgentKind | null
}

/** main -> overlay on 'ghost:point'. rect is in overlay-local DIPs. */
export interface GhostPoint {
  rect: Rect
  label?: string
  ms?: number
}

/** main -> dashboard on 'panel:replay': the expert's screenshots for one Work Map step. */
export interface ReplayCommand {
  step_id: string
  title?: string
  steps: GuideStep[]
}

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** Overlay window bounds and the primary display's work area, both in DIPs. */
export interface OverlayGeometry {
  bounds: Box
  workArea: Box
}
