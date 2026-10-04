// Curiosity, the always-on apprentice (PLAN §5.2 step 6): while the user is in an app, at a natural
// pause, ask one of that App Profile's open questions. Caps: 1 per hour per app, 3 per day.
// The ghost first shows "Got a sec?"; on "Answer" the App Profiles page opens with the question,
// and the typed answer is saved into the profile as an expert quote (profile:answer).
import type { AppContext, Popup, ServiceInit } from '@shared/contracts'
import { getStore } from './store'
import { getRollup } from './rollup'

export const CAPS = { perAppS: 3600, perDay: 3 }
const TICK_MS = 5000
/** A natural pause: no input for this long, after an action that finished recently, in an app used for a while. */
const IDLE_S = 5
const ACTION_FRESH_S = 60
const IN_APP_S = 30
const POPUP_GAP_S = 60
const POPUP_TIMEOUT_S = 20

export interface AskLog { asked: { key: string; q: string; at: number }[] }
export interface PauseState { key: string | null; inAppSince: number; lastInput: number; lastAction: number; lastPopup: number; busy: boolean }

/** Pure decision: may we ask now, and which question? */
export function pickQuestion(state: PauseState, questions: string[], log: AskLog, now: number): string | null {
  if (!state.key || state.busy || !questions.length) return null
  if (now - state.inAppSince < IN_APP_S || now - state.lastInput < IDLE_S || now - state.lastAction > ACTION_FRESH_S) return null
  if (now - state.lastPopup < POPUP_GAP_S) return null
  const day = new Date(now * 1000).toISOString().slice(0, 10)
  if (log.asked.filter((a) => new Date(a.at * 1000).toISOString().slice(0, 10) === day).length >= CAPS.perDay) return null
  if (log.asked.some((a) => a.key === state.key && now - a.at < CAPS.perAppS)) return null
  const recent = new Set(log.asked.filter((a) => now - a.at < 7 * 86400).map((a) => a.q.trim().toLowerCase()))
  return questions.find((q) => !recent.has(q.trim().toLowerCase())) ?? null
}

export const init: ServiceInit = async (ctx: AppContext) => {
  // Loaded lazily: these modules need Electron, and this file's logic is tested without it.
  const { isBusy } = await import('./session')
  const { openDashboard } = await import('./windows')
  const store = getStore(ctx)
  const rollup = getRollup(ctx)
  const now = () => Date.now() / 1000
  const state: PauseState = { key: null, inAppSince: 0, lastInput: 0, lastAction: 0, lastPopup: 0, busy: false }
  let log: AskLog = (await store.read<AskLog>(['curiosity.json']).catch(() => null)) ?? { asked: [] }
  const mine = new Map<string, { key: string; q: string }>()
  let checking = false

  ctx.bus.on('observer:event', (event) => {
    const t = now()
    if (event.type === 'blocked') { state.key = null; return }
    if (event.type === 'context') { if (event.key !== state.key) { state.key = event.key; state.inAppSince = t }; return }
    if (event.type === 'activity') state.lastInput = t
    if (event.type === 'click' || event.type === 'commit') { state.lastInput = t; state.lastAction = t }
  })
  ctx.bus.on('popup:show', () => { state.lastPopup = now() })
  ctx.bus.on('popup:answer', ({ id, choice }) => {
    const asked = mine.get(id)
    if (!asked) return
    mine.delete(id)
    if (choice === 'answer') openDashboard(`profiles?key=${encodeURIComponent(asked.key)}&q=${encodeURIComponent(asked.q)}`)
  })

  setInterval(() => {
    if (checking || !state.key) return
    checking = true
    void (async () => {
      state.busy = isBusy()
      const key = state.key
      const profile = key ? await rollup.read(key) : null
      const q = profile ? pickQuestion(state, profile.open_questions, log, now()) : null
      if (!q || !key || state.key !== key) return
      const popup: Popup = { id: `curiosity-${Date.now()}`, kind: 'curiosity', app_key: key, text: `Got a sec? ${q}`, speak: false, choices: [{ id: 'answer', label: 'Answer' }, { id: 'later', label: 'Not now' }], timeout_s: POPUP_TIMEOUT_S }
      mine.set(popup.id, { key, q })
      log = { asked: [...log.asked.filter((a) => now() - a.at < 30 * 86400), { key, q, at: now() }] }
      await store.write(['curiosity.json'], log)
      ctx.bus.emit('popup:show', popup)
    })().catch((error) => console.error('[curiosity]', error)).finally(() => { checking = false })
  }, TICK_MS).unref?.()
}
