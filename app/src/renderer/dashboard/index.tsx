import { useCallback, useEffect, useRef, useState } from 'react'
import type { Guide, GuideEdit, GuideStep } from '@shared/contracts'
import { desktopBridge, type DashboardBridge } from './bridge'
import { BlurEditor } from './BlurEditor'
import './dashboard.css'

export default function Dashboard({ bridge = desktopBridge() }: { bridge?: DashboardBridge }) {
  const [guides, setGuides] = useState<Guide[]>([])
  const [guide, setGuide] = useState<Guide | null>(null)
  const [stepId, setStepId] = useState('')
  const [title, setTitle] = useState('')
  const [note, setNote] = useState('')
  const [image, setImage] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [rename, setRename] = useState(false)
  const [guideTitle, setGuideTitle] = useState('')
  const current = useRef<Guide | null>(null)
  const dirty = useRef(false)
  const isBusy = useRef(false)
  const step = guide?.steps.find((candidate) => candidate.id === stepId)
  const unsaved = !!step && (title !== step.title || note !== step.note)
  dirty.current = unsaved || rename
  isBusy.current = busy
  current.current = guide

  const accept = useCallback((next: Guide, preferred?: string) => {
    setGuide(next)
    setGuides((previous) => [next, ...previous.filter((candidate) => candidate.id !== next.id)])
    setStepId((selected) => next.steps.some((candidate) => candidate.id === (preferred ?? selected)) ? preferred ?? selected : next.steps[0]?.id ?? '')
    setRename(false); setGuideTitle(next.title)
  }, [])
  useEffect(() => { setTitle(step?.title ?? ''); setNote(step?.note ?? '') }, [step?.id, step?.title, step?.note])
  const reload = useCallback(async () => {
    if (!bridge) { setLoading(false); return }
    setLoading(true); setError('')
    try {
      const result = await bridge.invoke('guides:list', {})
      setGuides(result)
      const selected = result.find((candidate) => candidate.id === current.current?.id) ?? result[0]
      if (selected) accept(selected)
      else setGuide(null)
      setNotice('')
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Unable to load guides.') }
    finally { setLoading(false) }
  }, [bridge, accept])
  useEffect(() => {
    void reload()
    if (!bridge) return
    const offGuide = bridge.on('guide:updated', (payload) => {
      const incoming = payload as Guide
      setGuides((previous) => [incoming, ...previous.filter((candidate) => candidate.id !== incoming.id)])
      if (current.current && incoming.id !== current.current.id) return
      if (dirty.current || isBusy.current) { if (!isBusy.current) setNotice('A newer version is available. Save may conflict; reload to use the latest guide.'); return }
      accept(incoming)
    })
    const offStatus = bridge.on('brain:status', (payload) => setNotice((payload as {message: string}).message))
    return () => { offGuide(); offStatus() }
  }, [bridge, reload, accept])
  useEffect(() => {
    let canceled = false
    setImage(null)
    if (bridge && guide && step?.shot && !step.screenshot_hidden) {
      void bridge.invoke('guide:image', { id: guide.id, step_id: step.id }).then((result) => { if (!canceled) setImage(result?.data_url ?? null) }).catch(() => { if (!canceled) setError('Screenshot could not be loaded.') })
    }
    return () => { canceled = true }
  }, [bridge, guide?.id, step?.id, step?.shot, step?.screenshot_hidden])
  async function run(operation: () => Promise<void>) {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try { await operation() } catch (failure) { setError(failure instanceof Error ? failure.message : 'Operation failed. Try again.') }
    finally { setBusy(false) }
  }
  function edit(edit: GuideEdit) {
    if (!bridge || !guide) return
    void run(async () => accept(await bridge.invoke('guide:save', { id: guide.id, revision: guide.revision ?? 0, edit })))
  }
  function selectGuide(next: Guide) { if (unsaved || rename) { setError('Save or discard your changes before switching guides.'); return }; accept(next, next.steps.find((candidate) => candidate.shot)?.id); setError(''); setNotice('') }
  function selectStep(next: GuideStep) { if (unsaved) { setError('Save or discard your changes before switching steps.'); return }; setStepId(next.id); setError('') }
  const locked = busy || !!guide?.recording
  return <div className="apprentice-dashboard">
    <header className="guide-header"><div className="guide-wordmark">apprentice<span>Knowledge workspace</span></div><span className="guide-local">Stored on this computer</span></header>
    <main>
      <div className="guide-page-heading"><div><p className="guide-eyebrow">Capture / Step guides</p><h1>The work, step by step.</h1><p>Turn an expert’s actions into a guide someone else can follow.</p></div><button disabled={busy} onClick={() => void reload()}>Reload guides</button></div>
      {error && <div className="guide-error" role="alert">{error}</div>}
      {notice && <div className="guide-notice" role="status">{notice}</div>}
      {!bridge ? <div className="guide-empty"><h2>Open this workspace in Apprentice</h2><p>The desktop connection is needed to read your locally stored guides.</p></div> : loading ? <div className="guide-empty" role="status">Loading guides…</div> : !guide ? <div className="guide-empty"><h2>Your first guide starts with a recording.</h2><p>Start a teach session or quick guide from the companion panel. Captured steps will appear here.</p></div> : <div className="guide-workspace">
        <aside className="guide-library" aria-label="Saved guides"><h2>Guides <span>{guides.length}</span></h2>{guides.map((item) => <button className={item.id === guide.id ? 'is-current' : ''} key={item.id} onClick={() => selectGuide(item)} aria-pressed={item.id === guide.id}><strong>{item.title}</strong><span>{item.steps.length} steps · {item.recording ? 'Recording' : 'Saved'}</span></button>)}</aside>
        <section className="guide-document">
          <div className="guide-document-heading"><div>{rename ? <form onSubmit={(event) => { event.preventDefault(); edit({ kind: 'rename', title: guideTitle }) }}><label>Guide title<input autoFocus value={guideTitle} maxLength={200} onChange={(event) => setGuideTitle(event.target.value)}/></label><button disabled={locked || !guideTitle.trim()}>Save title</button><button type="button" onClick={() => setRename(false)}>Cancel</button></form> : <><p className="guide-eyebrow">{guide.app || 'Recorded workflow'}</p><h2>{guide.title}</h2><button className="guide-text-button" disabled={locked || unsaved} onClick={() => { setGuideTitle(guide.title); setRename(true) }}>Rename guide</button></>}</div><button disabled={locked || unsaved} onClick={() => void run(async () => { const result = await bridge.invoke('guide:exportPdf', { id: guide.id }); setNotice(result.canceled ? 'PDF export canceled.' : 'PDF exported successfully.') })}>Export PDF</button></div>
          {guide.recording && <p className="guide-recording" role="status">Recording in progress. Steps update live. Stop the session to edit or export.</p>}
          <div className="guide-editor-layout">
            <nav className="guide-steps" aria-label="Guide steps">{guide.steps.map((item) => <button key={item.id} className={item.id === stepId ? 'is-current' : ''} onClick={() => selectStep(item)} aria-current={item.id === stepId ? 'step' : undefined}><span className="guide-step-number">{item.n.toString().padStart(2, '0')}</span><span><strong>{item.title}</strong><small>{item.kind}{item.shot ? ' · Screen captured' : ''}</small></span></button>)}<button className="guide-add-note" disabled={locked || unsaved} onClick={() => edit({ kind: 'note', after_id: step?.id, note: 'Add context for this part of the workflow.' })}>+ Insert note</button></nav>
            <div className="guide-step-editor">{step ? <>
              <div className="guide-step-heading"><p className="guide-eyebrow">Step {step.n} of {guide.steps.length}</p><span>{step.edited ? 'Edited' : 'Captured'}</span></div>
              <form onSubmit={(event) => { event.preventDefault(); edit({ kind: 'edit', step_id: step.id, title, note }) }}><label>Step title<input value={title} maxLength={300} disabled={locked} onChange={(event) => setTitle(event.target.value)}/></label><label>Notes<textarea value={note} maxLength={4000} rows={3} disabled={locked} placeholder="Add context, an exception, or a useful reminder." onChange={(event) => setNote(event.target.value)}/></label><div className="guide-edit-actions"><button className="guide-primary" disabled={locked || !unsaved || !title.trim()}>Save changes</button>{unsaved && <button type="button" onClick={() => { setTitle(step.title); setNote(step.note); setError('') }}>Discard changes</button>}</div></form>
              <div className="guide-step-actions"><button disabled={locked || unsaved || step.n === 1} onClick={() => edit({ kind: 'move', step_id: step.id, direction: 'up' })}>Move up</button><button disabled={locked || unsaved || step.n === guide.steps.length} onClick={() => edit({ kind: 'move', step_id: step.id, direction: 'down' })}>Move down</button><button disabled={locked || unsaved || step.n === 1} onClick={() => edit({ kind: 'merge', step_id: step.id })}>Merge with previous</button><button className="guide-danger" disabled={locked || unsaved} onClick={() => edit({ kind: 'delete', step_id: step.id })}>Delete step</button></div>
              {step.shot ? <><div className="guide-shot-toggle"><button disabled={locked || unsaved} onClick={() => edit({ kind: 'hide', step_id: step.id })}>{step.screenshot_hidden ? 'Show screenshot' : 'Hide screenshot'}</button></div>{step.screenshot_hidden ? <p className="guide-image-placeholder">Screenshot hidden from this guide and its exports.</p> : image ? <BlurEditor src={image} disabled={locked || unsaved} onApply={(data_url, region) => void run(async () => accept(await bridge.invoke('guide:blur', { id: guide.id, step_id: step.id, revision: guide.revision ?? 0, data_url, regions: [region] })))}/> : <p className="guide-image-placeholder">Loading screenshot…</p>}</> : <p className="guide-image-placeholder">No screenshot for this step.</p>}
              {step.screen_moment && <p className="guide-screen-moment">{step.screen_moment}</p>}
              {step.quote && <blockquote><p>“{step.quote.text}”</p><cite>Expert explanation · {step.quote.source ?? 'session'}</cite></blockquote>}
            </> : <div className="guide-empty"><h3>No steps yet</h3><p>Capture an action or insert a note to begin.</p></div>}</div>
          </div>
        </section>
      </div>}
    </main>
  </div>
}
