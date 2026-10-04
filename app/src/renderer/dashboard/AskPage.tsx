import { useRef, useState } from 'react'
import { ArrowUpRightIcon, SparkleIcon } from '@phosphor-icons/react'
import { Ghost } from '../mascot/Ghost'
import { errorText, type DashboardBridge } from './bridge'

type Message = { role: 'user' | 'assistant'; text: string; source?: 'model' | 'local'; guide?: string }
const SUGGESTIONS = [
  'What do you know about this task?',
  'What should I check before I submit?',
  'How do I teach a new hire?',
]

export function AskPage({ bridge }: { bridge: DashboardBridge }) {
  const [question, setQuestion] = useState('')
  const [messages, setMessages] = useState<Message[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const input = useRef<HTMLTextAreaElement>(null)

  async function ask(text = question) {
    const value = text.trim()
    if (!value || busy) return
    setQuestion(''); setError(''); setBusy(true)
    setMessages((current) => [...current, { role: 'user', text: value }])
    try {
      const reply = await bridge.invoke('assistant:ask', { question: value })
      setMessages((current) => [...current, { role: 'assistant', text: reply.answer, source: reply.source, guide: reply.guide }])
    } catch (failure) {
      setError(errorText(failure, 'Could not answer right now.'))
    } finally {
      setBusy(false)
      input.current?.focus()
    }
  }

  return <section className="ask-page" aria-label="Ask Protégé">
    <div className="ask-heading">
      <div className="ask-ghost" aria-hidden><Ghost state="idle" size={145} /></div>
      <div><span className="workspace-kicker">YOUR WORK COMPANION</span><h1>Ask whenever you need a hand.</h1>
        <p>Get help with a recorded task, a decision, or what to do next. Protégé uses your company profile and the guides you have made.</p></div>
    </div>
    <div className="ask-thread" aria-live="polite">
      {messages.length === 0 && <div className="ask-empty"><SparkleIcon size={20} /><strong>Start with a question</strong><p>Ask about a process you recorded or how Protégé works.</p>
        <div className="ask-suggestions">{SUGGESTIONS.map((s) => <button key={s} onClick={() => void ask(s)}>{s}<ArrowUpRightIcon size={16} /></button>)}</div>
      </div>}
      {messages.map((message, index) => <div className={`ask-message ${message.role}`} key={index}>
        <span>{message.role === 'assistant' ? 'Protégé' : 'You'}</span><p>{message.text}</p>
        {message.role === 'assistant' && <small>{message.guide ? `Based on “${message.guide}”` : message.source === 'local' ? 'Local guidance' : 'AI guidance'}</small>}
      </div>)}
      {busy && <p className="ask-thinking" role="status">Thinking through your question…</p>}
    </div>
    <form className="ask-composer" onSubmit={(e) => { e.preventDefault(); void ask() }}>
      <label htmlFor="ask-question">Your question</label>
      <div><textarea id="ask-question" ref={input} value={question} maxLength={1000} rows={2} onChange={(e) => setQuestion(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void ask() } }} placeholder="Ask about a task, rule, or next step…" />
        <button className="primary" disabled={busy || !question.trim()} aria-label="Send question"><ArrowUpRightIcon size={19} /></button></div>
      <small>Questions are masked before processing. Answers based on draft Work Maps may need expert confirmation.</small>
      {error && <p className="home-error" role="alert">{error}</p>}
    </form>
  </section>
}
