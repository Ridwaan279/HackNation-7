// Client tools (PLAN §7). Every tool forwards to main via 'agent:tool'; main turns it into bus
// events. The names must match the tools configured on the agents in the ElevenLabs dashboard.
import { tryInvoke } from '../lib/api'
import type { AgentKind } from '../../common/ipc'

export const TOOLS_BY_AGENT: Record<AgentKind, string[]> = {
  interviewer: ['record_answer'],
  debrief: ['record_answer', 'record_correction', 'teachback_confirmed'],
  tutor: ['point_at', 'replay_moment', 'mark_step'],
}

type ClientTool = (params: Record<string, unknown>) => Promise<string>

export function clientTools(agent: AgentKind): Record<string, ClientTool> {
  return Object.fromEntries(
    TOOLS_BY_AGENT[agent].map((name) => [
      name,
      async (args: Record<string, unknown>) => (await tryInvoke<string>('agent:tool', { name, args: args ?? {} })) ?? 'Done.',
    ])
  )
}
