// ElevenLabs on the main side: TTS one-liners for pop-ups, and conversation tokens for the agents.
// The API key never leaves the main process.
import type { ServiceInit } from '@shared/contracts'
import type { AgentAuth, AgentKind, TtsResult } from '../../common/ipc'
import { getSettings } from './settings'
import { getStore } from './store'

const API = 'https://api.elevenlabs.io/v1'

const AGENT_ENV: Record<AgentKind, string> = {
  interviewer: 'VITE_AGENT_INTERVIEWER',
  debrief: 'VITE_AGENT_DEBRIEF',
  tutor: 'VITE_AGENT_TUTOR',
  assistant: 'VITE_AGENT_ASSISTANT',
}

const key = () => process.env.ELEVENLABS_API_KEY ?? ''
const SOUNDS = {
  record_start: 'Soft warm two-note confirmation chime, delicate glass and felt, subtle desktop UI sound, no voice, no music, 0.7 seconds',
  curiosity: 'Small gentle inquisitive bubble pop with a bright shimmer, subtle desktop UI sound, no voice, no music, 0.7 seconds',
  guardrail: 'Gentle caution tone, two soft descending glass notes, helpful not alarming, desktop UI sound, no voice, no music, 0.7 seconds',
} as const
type SoundKind = keyof typeof SOUNDS
const soundJobs = new Map<SoundKind, Promise<TtsResult>>()

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
  const agentId = process.env[AGENT_ENV[agent]] || (agent === 'assistant' ? process.env.VITE_AGENT_TUTOR : '') || ''
  if (!agentId) return { error: `${AGENT_ENV[agent]} (or VITE_AGENT_TUTOR) not set in app/.env` }
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
  ctx.handle('tts:sound', (payload: { kind: SoundKind }) => {
    const kind = payload?.kind
    if (!Object.hasOwn(SOUNDS, kind)) return { error: 'Unknown sound' }
    if (!getSettings().soundEffects || !key() || !process.env.ELEVENLABS_SFX_MODEL) return { error: 'Sound effects are off or ElevenLabs is not configured' }
    const existing = soundJobs.get(kind)
    if (existing) return existing
    const job: Promise<TtsResult> = (async () => {
      const store = getStore(ctx)
      const file = ['sfx', `${kind}.mp3`]
      const cached = await store.readBytes(file, 250_000).catch(() => null)
      if (cached) return { audio: cached.toString('base64'), mime: 'audio/mpeg' }
      try {
        const response = await fetch(`${API}/sound-generation`, {
          method: 'POST',
          headers: { 'xi-api-key': key(), 'content-type': 'application/json', accept: 'audio/mpeg' },
          body: JSON.stringify({ text: SOUNDS[kind], duration_seconds: 0.7, model_id: process.env.ELEVENLABS_SFX_MODEL }),
        })
        if (!response.ok) return { error: `sound ${response.status}` }
        const bytes = Buffer.from(await response.arrayBuffer())
        if (!bytes.length || bytes.length > 250_000) return { error: 'Sound response was invalid' }
        await store.writeBytes(file, bytes)
        return { audio: bytes.toString('base64'), mime: 'audio/mpeg' }
      } catch (error) { return { error: String(error) } }
    })().finally(() => soundJobs.delete(kind))
    soundJobs.set(kind, job)
    return job
  })
  ctx.handle('agent:auth', (p: { agent: AgentKind }) => agentAuth(p.agent))
}
