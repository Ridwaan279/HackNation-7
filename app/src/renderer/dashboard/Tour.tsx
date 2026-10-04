import { useEffect, useRef, useState } from 'react'
import { ArrowLeftIcon, ArrowRightIcon, CheckCircleIcon, GearSixIcon, SpeakerHighIcon, SpeakerSlashIcon, SparkleIcon } from '@phosphor-icons/react'
import { Ghost } from '../mascot/Ghost'
import { errorText, type DashboardBridge, type SetupStatus, type Settings } from './bridge'

const scenes = [
  {
    number: '01', eyebrow: 'MEET YOUR APPRENTICE', title: 'I learn the way your team works.',
    body: 'I’m Protégé. Show me a task once and I’ll turn the steps and decisions into a guide that someone new can follow.',
    detail: 'Start every recording by naming what you are doing. You can attach reference files to the finished guide.',
  },
  {
    number: '02', eyebrow: 'BETWEEN RECORDINGS', title: 'Always-on learning, day and night.',
    body: 'While Protégé is running, I can learn 24/7 from allowed apps through Windows accessibility, even when you are not recording a task. I build App Profiles from masked fields, clicks and the patterns in how you work.',
    detail: 'Passwords are never read. You can pause observation, block apps, or erase memory in Privacy settings.',
  },
  {
    number: '03', eyebrow: 'THE OCCASIONAL QUESTION', title: 'I’ll ask when something needs explaining.',
    body: 'At a natural pause, I may ask why you did something a certain way—even if no recording is active. Your answer helps me teach the exception, not just repeat the clicks.',
    detail: 'Questions are limited to one per app per hour and three a day. You can always choose “Not now.”',
  },
  {
    number: '04', eyebrow: 'WHEN SOMEONE IS LEARNING', title: 'The right help, right on their screen.',
    body: 'Recordings become editable step guides and Work Maps. A new hire can practice with me beside them, and anyone can ask me a question by voice at any time.',
    detail: 'Open Ask Protégé or press Ctrl+Shift+Space to talk. Voice features need an ElevenLabs key and agent IDs.',
  },
  {
    number: '05', eyebrow: 'FINAL SETUP', title: 'Make Protégé yours.',
    body: 'Your company and role shape the questions and lessons. Add your own API keys to app/.env to enable AI analysis, voice and sound effects.',
    detail: 'The local recorder, privacy controls and App Profiles can still run without cloud keys. Save app/.env, then restart Protégé to load new keys.',
  },
] as const

export function Tour({ bridge, settings, done }: { bridge: DashboardBridge; settings: Settings; done: (s: Settings) => void }) {
  const [step, setStep] = useState(0)
  const [started, setStarted] = useState(false)
  const [muted, setMuted] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [setup, setSetup] = useState<SetupStatus | null>(null)
  const [error, setError] = useState('')
  const audio = useRef<HTMLAudioElement | null>(null)
  const generation = useRef(0)

  useEffect(() => { void bridge.invoke('setup:status', {}).then(setSetup).catch(() => undefined) }, [bridge])
  useEffect(() => () => { audio.current?.pause(); speechSynthesis.cancel(); generation.current++ }, [])

  function stopVoice() {
    generation.current++
    audio.current?.pause()
    audio.current = null
    speechSynthesis.cancel()
    setSpeaking(false)
  }

  async function narrate(index: number, force = false) {
    stopVoice()
    if (muted && !force) return
    const token = generation.current
    const line = `${scenes[index].title} ${scenes[index].body} ${scenes[index].detail}`
    setSpeaking(true)
    const result = await bridge.invoke('tts:speak', { text: line }).catch(() => null)
    if (generation.current !== token) return
    if (result && 'audio' in result) {
      const clip = new Audio(`data:${result.mime};base64,${result.audio}`)
      audio.current = clip
      clip.onended = () => setSpeaking(false)
      try { await clip.play(); return } catch { /* use the local voice below */ }
    }
    if ('speechSynthesis' in window) {
      const utterance = new SpeechSynthesisUtterance(line)
      utterance.rate = 0.96
      utterance.onend = () => setSpeaking(false)
      utterance.onerror = () => setSpeaking(false)
      speechSynthesis.speak(utterance)
    } else setSpeaking(false)
  }

  function go(index: number) { setStarted(true); setStep(index); void narrate(index) }
  async function finish() {
    stopVoice()
    try { done(await bridge.invoke('settings:set', { tourDone: true })) }
    catch (failure) { setError(errorText(failure, 'Could not finish the tour. Try again.')) }
  }
  async function openEnv() {
    try { await bridge.invoke('setup:openEnv', {}); setError('app/.env opened. Save it and restart Protégé to use your keys.') }
    catch (failure) { setError(errorText(failure, 'Could not open app/.env.')) }
  }

  const scene = scenes[step]
  return <div className="onboarding tour-shell">
    <header className="tour-top"><div className="onboarding-brand">Protégé <span>YOUR INTRODUCTION</span></div><button className="tour-skip" onClick={() => void finish()}>Skip tour</button></header>
    <main className="tour-main"><section className="tour-visual" aria-hidden="true">
      <div className="tour-orbit tour-orbit-one" /><div className="tour-orbit tour-orbit-two" />
      <Ghost state={speaking ? 'speaking' : 'idle'} size={340} />
      <span className="tour-visual-caption"><SparkleIcon size={15} /> YOUR AI APPRENTICE</span>
    </section>
      <section className="tour-copy" aria-live="polite"><div className="tour-progress">{scenes.map((s, index) => <span key={s.number} className={index <= step ? 'active' : ''} />)}</div>
        <span className="workspace-kicker">{scene.number} / 05 · {scene.eyebrow}</span>
        <h1>{scene.title}</h1><p className="tour-body">{scene.body}</p><p className="tour-detail">{scene.detail}</p>
        {step === 4 && <div className="tour-config"><div><GearSixIcon size={18} /><strong>AI and voice setup</strong></div>
          {setup && <p>{setup.openai && setup.models ? 'AI analysis ready' : 'AI analysis needs OpenAI and model settings'} · {setup.elevenlabs && setup.voiceAgents ? 'Voice ready' : 'Voice needs ElevenLabs and agent IDs'}</p>}
          <button onClick={() => void openEnv()}>Open app/.env</button></div>}
        {error && <p className="tour-message" role="status">{error}</p>}
        <div className="tour-actions"><button className="tour-back" disabled={step === 0} onClick={() => go(step - 1)}><ArrowLeftIcon size={17} /> Back</button>
          {!started ? <button className="tour-next" onClick={() => go(0)}><SpeakerHighIcon size={17} /> Start narrated tour</button>
            : step < scenes.length - 1 ? <button className="tour-next" onClick={() => go(step + 1)}>Next <ArrowRightIcon size={17} /></button>
              : <button className="tour-next" onClick={() => void finish()}>Open workspace <CheckCircleIcon size={17} /></button>}
          <button className="tour-audio" onClick={() => { if (muted) { setMuted(false); void narrate(step, true) } else { setMuted(true); stopVoice() } }} aria-label={muted ? 'Turn narration on' : 'Mute narration'} title={muted ? 'Turn narration on' : 'Mute narration'}>{muted ? <SpeakerSlashIcon size={19} /> : <SpeakerHighIcon size={19} />}</button>
        </div>
      </section></main>
    <footer className="tour-foot">{settings.company} · {settings.role} <span>Privacy settings are always yours to change.</span></footer>
  </div>
}
