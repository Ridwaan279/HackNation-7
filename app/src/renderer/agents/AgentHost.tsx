// Hosts the ElevenLabs conversation in the overlay. Driven entirely by 'agent:command' from main;
// reports status, transcripts and voice activity back. Must sit inside <ConversationProvider>.
import { useEffect, useRef } from 'react'
import { useConversation } from '@elevenlabs/react'
import { invoke, tryInvoke, useChannel } from '../lib/api'
import type { AgentAuth, AgentCommand, AgentKind, AgentStatus } from '../../common/ipc'
import { getMic, micLabel, onMicChange } from '../lib/mic'
import { clientTools } from './tools'

export interface AgentUi {
  agent: AgentKind | null
  connected: boolean
  speaking: boolean
  userSpeaking: boolean
  /** Latest agent line, for the caption bubble. */
  caption: string | null
}

interface Props {
  onUi: (ui: AgentUi) => void
  /** Called ~15×/s while the agent speaks. */
  onVolume: (v: number) => void
  /** Mic input level 0..1, ~15×/s while connected; 0 when disconnected. */
  onMicLevel: (v: number) => void
  /** Name of the microphone in use, once connected. */
  onMicName: (name: string) => void
}

const VAD_ON = 0.6
const VAD_REPORT_MS = 400

export function AgentHost({ onUi, onVolume, onMicLevel, onMicName }: Props) {
  const agentRef = useRef<AgentKind | null>(null)
  const ui = useRef<AgentUi>({ agent: null, connected: false, speaking: false, userSpeaking: false, caption: null })
  const lastVad = useRef(0)
  const pending = useRef<AgentCommand | null>(null)

  const update = (patch: Partial<AgentUi>) => {
    ui.current = { ...ui.current, ...patch }
    onUi(ui.current)
  }
  const report = (s: Partial<AgentStatus>) => void tryInvoke('agent:status', { agent: agentRef.current, ...s })
  /** Shows up in the terminal running `npm run dev`. */
  const log = (message: string) => void tryInvoke('agent:log', { message })

  const conv = useConversation({
    onStatusChange: ({ status }) => {
      report({ status })
      update({ connected: status === 'connected', agent: status === 'disconnected' ? null : agentRef.current })
      if (status === 'disconnected') {
        agentRef.current = null
        const next = pending.current
        pending.current = null
        if (next?.op === 'start') void start(next)
      }
    },
    onModeChange: ({ mode }) => {
      report({ mode })
      update({ speaking: mode === 'speaking' })
    },
    onMessage: ({ role, message }) => {
      void tryInvoke('agent:message', { role, text: message })
      if (role === 'agent') update({ caption: message })
    },
    onVadScore: ({ vadScore }) => {
      const speaking = vadScore > VAD_ON
      const t = Date.now()
      if (speaking !== ui.current.userSpeaking || (speaking && t - lastVad.current > VAD_REPORT_MS)) {
        lastVad.current = t
        report({ userSpeaking: speaking })
        if (speaking !== ui.current.userSpeaking) update({ userSpeaking: speaking })
      }
    },
    onConnect: () => {
      void micLabel().then((name) => {
        onMicName(name)
        log(`connected (${agentRef.current}); microphone: ${name}`)
      })
    },
    onError: (message, context) => {
      console.error('[agent] error', message, context)
      log(`error: ${message}`)
    },
    onDisconnect: (details) => log(`disconnected: ${details.reason}${'message' in details ? ` (${details.message})` : ''}`),
  })

  // Keep a stable handle so command handlers always see the latest controls.
  const convRef = useRef(conv)
  convRef.current = conv

  async function start(cmd: Extract<AgentCommand, { op: 'start' }>) {
    const auth = await invoke<AgentAuth>('agent:auth', { agent: cmd.agent })
    if (auth.error || (!auth.conversationToken && !auth.agentId)) {
      console.error(`[agent] cannot start ${cmd.agent}:`, auth.error)
      return
    }
    agentRef.current = cmd.agent
    update({ agent: cmd.agent, caption: null })
    const mic = getMic()
    const common = {
      ...(mic ? { inputDeviceId: mic } : {}),
      dynamicVariables: cmd.dynamicVariables,
      clientTools: clientTools(cmd.agent),
      ...(cmd.firstMessage ? { overrides: { agent: { firstMessage: cmd.firstMessage } } } : {}),
    }
    if (auth.conversationToken)
      convRef.current.startSession({ ...common, conversationToken: auth.conversationToken, connectionType: 'webrtc' })
    else convRef.current.startSession({ ...common, agentId: auth.agentId!, connectionType: 'webrtc' })
  }

  useChannel<AgentCommand>('agent:command', (cmd) => {
    const c = convRef.current
    const live = c.status === 'connected'
    switch (cmd.op) {
      case 'start':
        if (c.status === 'disconnected') void start(cmd)
        else {
          // Switch agents: hang up first, start once disconnected.
          pending.current = cmd
          c.endSession()
        }
        break
      case 'stop':
        pending.current = null
        if (c.status !== 'disconnected') c.endSession()
        break
      case 'nudge':
        if (live) c.sendUserMessage(cmd.text)
        break
      case 'context':
        if (live) c.sendContextualUpdate(cmd.text)
        break
      case 'activity':
        if (live) c.sendUserActivity()
        break
      case 'mute':
        c.setMuted(cmd.muted)
        break
    }
  })

  // Switch microphones live when the panel picks another one.
  useEffect(
    () =>
      onMicChange((deviceId) => {
        const c = convRef.current
        if (c.status !== 'connected') return
        void c
          .changeInputDevice({ inputDeviceId: deviceId || 'default' })
          .then(() => micLabel(deviceId))
          .then((name) => {
            onMicName(name)
            log(`microphone switched to: ${name}`)
          })
          .catch((err) => log(`could not switch microphone: ${String(err)}`))
      }),
    [onMicName]
  )

  // Output volume -> ghost glow; input volume -> mic meter.
  useEffect(() => {
    let raf = 0
    let last = 0
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop)
      if (t - last < 66) return
      last = t
      const c = convRef.current
      const connected = c.status === 'connected'
      onVolume(connected && c.isSpeaking ? c.getOutputVolume() : 0)
      onMicLevel(connected ? c.getInputVolume() : 0)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [onVolume, onMicLevel])

  return null
}
