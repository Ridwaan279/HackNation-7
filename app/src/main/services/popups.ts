// Pop-ups raised by the shell itself (PLAN §5.2, §5.8): "can't read this app → screen record instead?",
// "want to teach me this app?", and short notices for observer warnings. Curiosity pop-ups come from
// Agent C on the same 'popup:show' bus event; their answers go back out as 'popup:answer'.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { A11yHealthEvent, AppContext, Popup, PrivacyConfig, ServiceInit, WarningEvent } from '@shared/contracts'
import { isBusy } from './session'
import { openDashboard } from './windows'
import { getSettings } from './settings'

/** Foreground time in a never-offered app before offering a teach session. */
const TEACH_AFTER_S = 120
const TICK_MS = 5000
/** Don't stack a new pop-up on one shown less than this long ago. */
const POPUP_GAP_MS = 15000
const WARNING_EVERY_MS = 5 * 60 * 1000

const KNOWN_APPS: Record<string, string> = {
  'msedge.exe': 'Edge',
  'chrome.exe': 'Chrome',
  'firefox.exe': 'Firefox',
  'excel.exe': 'Excel',
  'winword.exe': 'Word',
  'outlook.exe': 'Outlook',
  'powerpnt.exe': 'PowerPoint',
  'ms-teams.exe': 'Teams',
  'code.exe': 'VS Code',
  'explorer.exe': 'File Explorer',
  'mstsc.exe': 'Remote Desktop',
}

const WARNING_TEXT: Partial<Record<WarningEvent['code'], (detail?: string) => string>> = {
  sidecar_restarted: () => 'My observer restarted. I may have missed a moment.',
  hook_restarted: () => 'I lost track of your mouse for a second. Reconnected.',
  uia_timeout: (d) => `${d ? appName(d) : 'This app'} isn't responding, so I can't read it right now.`,
  display_mismatch: () => 'Your displays changed. Recalibrating where I point.',
  dpi_unaware: () => "I couldn't detect display scaling, so my pointing may be off.",
}

interface Offers {
  /** app key -> when the teach offer was shown and what was answered. */
  teach: Record<string, { at: string; choice?: string }>
}

type Pending = { kind: 'a11y'; key: string } | { kind: 'teach'; key: string } | { kind: 'other' }

let ctx: AppContext
let offers: Offers = { teach: {} }
const usage = new Map<string, number>()
let fg: { key: string; since: number } | null = null
const pending = new Map<string, Pending>()
let lastShown = 0
const lastWarning = new Map<string, number>()

const offersFile = () => join(ctx.paths.root, 'popups.json')
const today = () => new Date().toISOString().slice(0, 10)

export function appName(key: string) {
  if (key.startsWith('browser:')) return key.slice(8).replace(/^www\./, '')
  return KNOWN_APPS[key.toLowerCase()] ?? key.replace(/\.exe$/i, '').replace(/^./, (c) => c.toUpperCase())
}

function loadOffers() {
  try {
    if (existsSync(offersFile())) offers = { teach: {}, ...JSON.parse(readFileSync(offersFile(), 'utf8')) }
  } catch (err) {
    console.warn('[popups] could not read popups.json:', err)
  }
}

function saveOffers() {
  writeAtomic(offersFile(), offers)
}

function writeAtomic(file: string, data: unknown) {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2))
  renameSync(tmp, file)
}

function show(p: Omit<Popup, 'id'>, meta: Pending): string {
  const id = `${p.kind}-${Date.now()}`
  pending.set(id, meta)
  lastShown = Date.now()
  ctx.bus.emit('popup:show', { ...p, id })
  return id
}

// ---------------------------------------------------------------- a11y blind

function onHealth(e: A11yHealthEvent) {
  // The sidecar decides when to ask (once per app per 24 h, never after "never").
  if (e.status !== 'blind' || e.prompt !== true) return
  const name = appName(e.key)
  const tip = e.hint === 'chromium_flag' ? ' (Or restart it with accessibility turned on.)' : ''
  show(
    {
      kind: 'a11y_blind',
      app_key: e.key,
      text: `I can't read ${name}. Want me to watch it by screen recording instead?${tip} I can't blur private fields automatically in that mode.`,
      speak: true,
      choices: [
        { id: 'yes', label: 'Yes, record it' },
        { id: 'not_now', label: 'Not now' },
        { id: 'never', label: 'Never watch this app' },
      ],
      timeout_s: 20,
    },
    { kind: 'a11y', key: e.key }
  )
}

async function answerA11y(key: string, choice: string) {
  const ack = choice === 'yes' ? 'yes' : choice === 'never' ? 'never' : 'later'
  try {
    await ctx.bus.request('observer:a11yAck', { key, choice: ack })
  } catch (err) {
    console.warn('[popups] observer:a11yAck failed:', (err as Error).message)
  }
}

// ------------------------------------------------------ "teach me this app?"

function accumulate() {
  if (!fg) return
  const t = Date.now()
  usage.set(fg.key, (usage.get(fg.key) ?? 0) + (t - fg.since) / 1000)
  fg.since = t
}

function maybeOfferTeach() {
  accumulate()
  if (!getSettings().onboarded || !getSettings().company.trim() || !getSettings().role.trim()) return
  if (!fg || isBusy() || Date.now() - lastShown < POPUP_GAP_MS) return
  const key = fg.key
  if ((usage.get(key) ?? 0) < TEACH_AFTER_S) return
  const prior = offers.teach[key]
  // Asked today already, or answered Yes / Never before: don't ask again.
  if (prior && (prior.at.startsWith(today()) || prior.choice === 'yes' || prior.choice === 'never')) return
  offers.teach[key] = { at: new Date().toISOString() }
  saveOffers()
  show(
    {
      kind: 'teach_app',
      app_key: key,
      text: `Want to teach me ${appName(key)}? I'll watch and ask the odd question.`,
      speak: true,
      choices: [
        { id: 'yes', label: 'Yes' },
        { id: 'not_now', label: 'Not now' },
        { id: 'never', label: 'Never for this app' },
      ],
    },
    { kind: 'teach', key }
  )
}

/** "Never for this app" adds it to the block list (PLAN §5.2), then asks the sidecar to re-read it. */
async function blockApp(key: string) {
  const file = join(ctx.paths.config, 'privacy.json')
  try {
    if (!existsSync(file)) throw new Error('privacy.json not created yet')
    const cfg = JSON.parse(readFileSync(file, 'utf8')) as PrivacyConfig
    const [list, value] = key.startsWith('browser:') ? (['blocked_domains', key.slice(8)] as const) : (['blocked_apps', key] as const)
    if (!cfg[list].includes(value)) cfg[list].push(value)
    writeAtomic(file, cfg)
    await ctx.bus.request('observer:reloadConfig', {})
  } catch (err) {
    console.warn(`[popups] could not block ${key}:`, (err as Error).message)
  }
}

async function answerTeach(key: string, choice: string) {
  offers.teach[key] = { at: offers.teach[key]?.at ?? new Date().toISOString(), choice }
  saveOffers()
  if (choice === 'yes') openDashboard('record?new=1')
  if (choice === 'never') await blockApp(key)
}

// ------------------------------------------------------------------ warnings

function onWarning(e: WarningEvent) {
  const text = WARNING_TEXT[e.code]?.(e.detail)
  if (!text) return
  const t = Date.now()
  if (t - (lastWarning.get(e.code) ?? 0) < WARNING_EVERY_MS) return
  lastWarning.set(e.code, t)
  show({ kind: 'warning', text, speak: false, choices: [], timeout_s: 6 }, { kind: 'other' })
}

// ---------------------------------------------------------------------- init

export const init: ServiceInit = (c) => {
  ctx = c
  loadOffers()

  c.bus.on('observer:event', (e) => {
    switch (e.type) {
      case 'context':
        accumulate()
        fg = { key: e.key, since: Date.now() }
        break
      case 'blocked':
        accumulate()
        fg = null
        break
      case 'a11y_health':
        onHealth(e)
        break
      case 'warning':
        onWarning(e)
        break
    }
  })

  c.bus.on('popup:answer', ({ id, choice }) => {
    const p = pending.get(id)
    if (!p) return
    pending.delete(id)
    if (p.kind === 'a11y') void answerA11y(p.key, choice)
    if (p.kind === 'teach') void answerTeach(p.key, choice)
  })

  setInterval(maybeOfferTeach, TICK_MS)
}
