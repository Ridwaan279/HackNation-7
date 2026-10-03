// ElevenLabs on the main side: TTS one-liners for pop-ups, and conversation tokens for the agents.
// The API key never leaves the main process.
import type { ServiceInit } from '@shared/contracts'
import type { AgentAuth, AgentKind, TtsResult } from '../../common/ipc'

const API = 'https://api.elevenlabs.io/v1'

const AGENT_ENV: Record<AgentKind, string> = {
  interviewer: 'VITE_AGENT_INTERVIEWER',
  debrief: 'VITE_AGENT_DEBRIEF',
  tutor: 'VITE_AGENT_TUTOR',
}

const key = () => process.env.ELEVENLABS_API_KEY ?? ''

export async function speak(text: string): Promise<TtsResult> {
  if (!key()) return { error: 'ELEVENLABS_API_KEY not set' }
  const voice = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8NyzM'
  const model = process.env.ELEVENLABS_TTS_MODEL || 'eleven_flash_v2_5'
  try {
    const res = await fetch(`${API}/text-to-speech/${voice}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': key(), 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: model }),
    })
    if (!res.ok) return { error: `tts ${res.status}: ${(await res.text()).slice(0, 200)}` }
    return { audio: Buffer.from(await res.arrayBuffer()).toString('base64'), mime: 'audio/mpeg' }
  } catch (err) {
    return { error: String(err) }
  }
}

/** Private agents need a WebRTC conversation token; public agents work with the bare agent ID. */
export async function agentAuth(agent: AgentKind): Promise<AgentAuth> {
  const agentId = process.env[AGENT_ENV[agent]] ?? ''
  if (!agentId) return { error: `${AGENT_ENV[agent]} not set in app/.env` }
  if (!key()) return { agentId }
  try {
    const res = await fetch(`${API}/convai/conversation/token?agent_id=${encodeURIComponent(agentId)}`, {
      headers: { 'xi-api-key': key() },
    })
    if (!res.ok) {
      console.warn(`[tts] conversation token ${res.status}; falling back to public agent id`)
      return { agentId }
    }
    const { token } = (await res.json()) as { token?: string }
    return token ? { conversationToken: token } : { agentId }
  } catch (err) {
    console.warn('[tts] conversation token failed; falling back to public agent id', err)
    return { agentId }
  }
}

export const init: ServiceInit = (ctx) => {
  ctx.handle('tts:speak', (p: { text: string }) => speak(p.text))
  ctx.handle('agent:auth', (p: { agent: AgentKind }) => agentAuth(p.agent))
}
