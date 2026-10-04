import { useEffect, useState } from 'react'
import { CircleNotchIcon, MicrophoneIcon, ShieldCheckIcon, StopIcon, WaveformIcon } from '@phosphor-icons/react'
import type { VoiceHelpState } from '../../main/services/assistant'
import { Ghost } from '../mascot/Ghost'
import { errorText, type DashboardBridge, type SessionInfo } from './bridge'

const INITIAL: VoiceHelpState = { agent: null, status: 'disconnected', mode: 'listening', userSpeaking: false }
const EXAMPLES = ['“What should I check before I submit?”', '“Why did the expert choose this step?”', '“How do I teach Protégé a new task?”']

export function AskPage({ bridge, session }: { bridge: DashboardBridge; session: SessionInfo }) {
  const [voice, setVoice] = useState<VoiceHelpState>(INITIAL)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    void bridge.invoke('assistant:state', {}).then(setVoice).catch(() => undefined)
    return bridge.on('assistant:state', (next) => setVoice(next as VoiceHelpState))
  }, [bridge])

  const sessionVoice = (session.phase === 'live' && session.kind !== 'quick_guide') || session.phase === 'debrief'
  const active = voice.status === 'connected'
  const helper = voice.agent === 'assistant' && voice.status !== 'disconnected'
  const listening = active && voice.mode !== 'speaking'
  const headline = voice.status === 'connecting' ? 'Connecting your microphone…'
    : voice.status === 'disconnecting' ? 'Ending the conversation…'
    : active && voice.mode === 'speaking' ? 'Protégé is speaking'
    : listening && voice.userSpeaking ? 'Protégé is listening to you'
    : listening ? 'Ask your question out loud'
    : sessionVoice ? 'Your voice agent is ready in this session'
    : 'A question away from clarity.'

  async function change(action: 'start' | 'stop') {
    setBusy(true)
    setError('')
    try {
      const next = await bridge.invoke(action === 'start' ? 'assistant:start' : 'assistant:stop', {})
      setVoice(next)
      if (next.error) setError(next.error)
    } catch (failure) {
      setError(errorText(failure, 'Could not start voice. Check your microphone and try again.'))
    } finally {
      setBusy(false)
    }
  }

  return <section className="ask-page" aria-label="Ask Protégé by voice">
    <div className="ask-heading">
      <div className="ask-ghost" aria-hidden><Ghost state={active ? voice.mode === 'speaking' ? 'speaking' : voice.userSpeaking ? 'listening' : 'idle' : 'idle'} size={145} /></div>
      <div><span className="workspace-kicker">YOUR WORK COMPANION</span><h1>Talk it through with Protégé.</h1>
        <p>Ask a question about a task, a decision, or what to do next. Protégé speaks with you using your role and recorded training.</p></div>
    </div>
    <div className={`ask-voice-card ${active ? 'is-active' : ''}`}>
      <div className={`ask-voice-orb ${active ? 'is-active' : ''} ${voice.mode === 'speaking' ? 'is-speaking' : ''}`} aria-hidden><WaveformIcon size={42} weight="light" /></div>
      <span className="workspace-kicker">ELEVENLABS VOICE</span>
      <h2 role="status">{headline}</h2>
      <p>{sessionVoice
        ? 'Your session agent can answer you now. Just speak naturally while the recording or debrief continues.'
        : active ? 'Your microphone is live. Speak naturally, then pause to hear the answer.'
        : 'Start a voice conversation whenever you need help. You can return to your work while Protégé listens.'}</p>
      {helper ? <button className="ask-voice-end" disabled={busy || voice.status === 'disconnecting'} onClick={() => void change('stop')}><StopIcon size={18} weight="fill" /> End conversation</button>
        : !sessionVoice && <button className="ask-voice-start" disabled={busy} onClick={() => void change('start')}>{busy ? <CircleNotchIcon className="spin" size={19} /> : <MicrophoneIcon size={19} />} Start voice conversation</button>}
      {(error || voice.error) && <p className="ask-voice-error" role="alert">{error || voice.error}</p>}
    </div>
    <div className="ask-voice-foot">
      <div><span className="ask-voice-foot-icon"><MicrophoneIcon size={18} /></span><div><strong>Try asking</strong><p>{EXAMPLES.join('  ·  ')}</p></div></div>
      <div><span className="ask-voice-foot-icon"><ShieldCheckIcon size={18} /></span><div><strong>Privacy</strong><p>Your saved training context is masked before it is shared. Your live voice is processed by ElevenLabs while the conversation is active.</p></div></div>
    </div>
  </section>
}
