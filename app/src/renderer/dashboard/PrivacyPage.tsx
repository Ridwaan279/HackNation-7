import { useCallback, useEffect, useState } from 'react'
import type { PrivacyConfig } from '@shared/contracts'
import { appLabel, errorText, type DashboardBridge, type PrivacyState, type Settings } from './bridge'

const MASKS: [keyof PrivacyConfig['mask'], string, string][] = [
  ['passwords', 'Passwords', '“password: …” in text. Password fields are never read at all.'],
  ['secrets', 'API keys and tokens', 'Known key prefixes, JWTs, private keys, long random strings.'],
  ['cards', 'Card numbers', 'Keeps the last 4 digits of valid numbers.'],
  ['iban', 'IBANs', 'Keeps the last 4 characters of valid IBANs.'],
  ['ssn', 'US Social Security numbers', ''],
  ['email', 'Email addresses', 'Off by default: supplier contacts are often part of the work.'],
  ['phone', 'Phone numbers', 'Off by default.'],
]
const SKIPS: [keyof PrivacyConfig['skip'], string][] = [['password_managers', 'Password managers'], ['banking', 'Banking sites'], ['private_windows', 'Private and incognito windows']]
const lines = (text: string) => text.split(/[\n,]/).map((s) => s.trim()).filter(Boolean)

export function PrivacyPage({ bridge }: { bridge?: DashboardBridge }) {
  const [state, setState] = useState<PrivacyState | null>(null)
  const [draft, setDraft] = useState<PrivacyConfig | null>(null)
  const [text, setText] = useState({ apps: '', domains: '', allow: '', local: '' })
  const [settings, setSettings] = useState<Settings | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const accept = useCallback((next: PrivacyState) => {
    setState(next); setDraft(next.privacy)
    setText({ apps: next.privacy.blocked_apps.join('\n'), domains: next.privacy.blocked_domains.join('\n'), allow: (next.privacy.allow_only ?? []).join('\n'), local: next.privacy.local_only_apps.join('\n') })
  }, [])
  const reload = useCallback(async () => {
    if (!bridge) return
    try { accept(await bridge.invoke('privacy:get', {})); setSettings(await bridge.invoke('settings:get', {})); setError('') }
    catch (failure) { setError(errorText(failure, 'Unable to load privacy settings.')) }
  }, [bridge, accept])
  useEffect(() => { void reload() }, [reload])
  async function run(operation: () => Promise<void>, done: string) {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try { await operation(); setNotice(done) } catch (failure) { setError(errorText(failure)) } finally { setBusy(false) }
  }
  if (!bridge) return <div className="guide-empty"><h2>Open this workspace in Apprentice</h2></div>
  if (!draft || !state || !settings) return <>{error ? <div className="guide-error" role="alert">{error}</div> : <div className="guide-empty" role="status">Loading…</div>}</>
  const allowOnly = draft.allow_only !== null
  const save = () => run(async () => accept(await bridge.invoke('privacy:set', {
    ...draft, blocked_apps: lines(text.apps), blocked_domains: lines(text.domains), local_only_apps: lines(text.local), allow_only: allowOnly ? lines(text.allow) : null,
  })), 'Saved. The observer reloaded its rules.')
  const set = <K extends keyof PrivacyConfig>(k: K, v: PrivacyConfig[K]) => setDraft({ ...draft, [k]: v })
  const modes = Object.entries(state.app_modes)
  return <>
    <div className="guide-page-heading"><div><p className="guide-eyebrow">Trust / Privacy</p><h1>You decide what it sees.</h1><p>Masking happens on this computer before anything is stored or sent.</p></div><button className="guide-primary" disabled={busy} onClick={() => void save()}>Save privacy settings</button></div>
    {error && <div className="guide-error" role="alert">{error}</div>}
    {notice && <div className="guide-notice" role="status">{notice}</div>}
    <div className="privacy-grid">
      <section className="dash-card"><h3>Pause watching</h3>
        <p className="dash-muted">{state.paused_until ? `Paused until ${new Date(state.paused_until).toLocaleString()}.` : 'Watching is on. Ctrl+Shift+O switches off the record at any time.'}</p>
        <div className="dash-actions">{[15, 60].map((m) => <button key={m} disabled={busy} onClick={() => void run(async () => accept(await bridge.invoke('privacy:pause', { minutes: m })), `Paused for ${m === 60 ? '1 hour' : `${m} minutes`}.`)}>{m === 60 ? '1 hour' : `${m} min`}</button>)}<button disabled={busy} onClick={() => void run(async () => accept(await bridge.invoke('privacy:pause', { minutes: 'tomorrow' })), 'Paused until tomorrow.')}>Until tomorrow</button>{state.paused_until && <button className="guide-primary" disabled={busy} onClick={() => void run(async () => accept(await bridge.invoke('privacy:resume', {})), 'Watching again.')}>Resume</button>}</div>
      </section>
      <section className="dash-card"><h3>About you</h3>
        <form className="dash-form" onSubmit={(e) => { e.preventDefault(); void run(async () => setSettings(await bridge.invoke('settings:set', { role: settings.role, expert: settings.expert, onboarded: true })), 'Saved.') }}>
          <label>Role being taught<input value={settings.role} maxLength={80} onChange={(e) => setSettings({ ...settings, role: e.target.value })} /></label>
          <label>Expert’s name<input value={settings.expert} maxLength={60} onChange={(e) => setSettings({ ...settings, expert: e.target.value })} /></label>
          <button disabled={busy || !settings.role.trim() || !settings.expert.trim()}>Save</button>
        </form>
      </section>
      <section className="dash-card"><h3>Mask in text</h3>{MASKS.map(([k, label, hint]) => <label key={k} className="dash-toggle"><input type="checkbox" checked={draft.mask[k]} onChange={(e) => set('mask', { ...draft.mask, [k]: e.target.checked })} /><span><strong>{label}</strong>{hint && <small>{hint}</small>}</span></label>)}</section>
      <section className="dash-card"><h3>Never watch</h3>{SKIPS.map(([k, label]) => <label key={k} className="dash-toggle"><input type="checkbox" checked={draft.skip[k]} onChange={(e) => set('skip', { ...draft.skip, [k]: e.target.checked })} /><span><strong>{label}</strong></span></label>)}
        <label className="dash-field">Blocked apps (process names, one per line)<textarea rows={3} value={text.apps} placeholder="slack.exe" onChange={(e) => setText({ ...text, apps: e.target.value })} /></label>
        <label className="dash-field">Blocked domains (wildcards allowed)<textarea rows={3} value={text.domains} placeholder="*.mybank.com" onChange={(e) => setText({ ...text, domains: e.target.value })} /></label>
      </section>
      <section className="dash-card"><h3>Allow-only mode</h3><label className="dash-toggle"><input type="checkbox" checked={allowOnly} onChange={(e) => set('allow_only', e.target.checked ? lines(text.allow) : null)} /><span><strong>Watch only the apps and domains listed</strong><small>For company deployments.</small></span></label>
        {allowOnly && <label className="dash-field">Allowed apps and domains<textarea rows={3} value={text.allow} placeholder={'excel.exe\nminierp.local'} onChange={(e) => setText({ ...text, allow: e.target.value })} /></label>}
        <label className="dash-field">Local-only apps (never sent to a model)<textarea rows={2} value={text.local} placeholder="browser:hr.example.com" onChange={(e) => setText({ ...text, local: e.target.value })} /></label>
      </section>
      <section className="dash-card"><h3>Keeping data</h3>
        <label className="dash-field">Delete raw ambient logs after (days)<input type="number" min={1} max={365} value={draft.raw_retention_days} onChange={(e) => set('raw_retention_days', Math.max(1, Math.min(365, Number(e.target.value) || 1)))} /></label>
        <label className="dash-toggle"><input type="checkbox" checked={draft.ambient_screenshots} onChange={(e) => set('ambient_screenshots', e.target.checked)} /><span><strong>Occasional ambient screenshots</strong><small>About once a minute when the screen changed. Described in words, then deleted.</small></span></label>
      </section>
      <section className="dash-card"><h3>Apps watched by screen recording</h3>
        {modes.length ? <ul className="capture-list">{modes.map(([key, mode]) => <li key={key}><span><strong>{appLabel(key)}</strong><small>{key}{mode.rect_scale ? ` · scaling corrected ×${mode.rect_scale}` : ''}</small></span><span className="capture-mode"><span className="dash-chip">{mode.capture === 'vision' ? 'Screen recording' : 'Accessibility'}</span><button disabled={busy} onClick={() => void run(async () => accept(await bridge.invoke('privacy:setCapture', { key, value: mode.capture === 'vision' ? 'uia' : 'vision' })), 'Capture mode changed.')}>{mode.capture === 'vision' ? 'Use accessibility' : 'Use screen recording'}</button></span></li>)}</ul> : <p className="dash-muted">Every app is read through accessibility. Apps that can’t be read are offered screen recording when you use them.</p>}
      </section>
      <section className="dash-card danger-zone"><h3>Delete everything</h3><p className="dash-muted">Ambient memory, App Profiles, guides, Work Maps, sessions, lessons and screenshots. Privacy settings stay.</p>
        <button className="guide-danger" disabled={busy} onClick={() => { if (window.confirm('Delete everything the apprentice has stored on this computer? This cannot be undone.')) void run(async () => { await bridge.invoke('data:deleteAll', {}) }, 'Everything was deleted.') }}>Delete everything</button>
      </section>
    </div>
  </>
}
