import { app, globalShortcut } from 'electron'
import type { ServiceInit } from '@shared/contracts'
import { isRecording, stopSession, toggleOffRecord } from './session'
import { openDashboard } from './windows'

const KEYS: Record<string, () => unknown> = {
  // Off the record: pause everything, mute the agent's mic, mark the gap.
  'CommandOrControl+Shift+O': () => toggleOffRecord(),
  // Record / stop a teach session.
  'CommandOrControl+Shift+R': () => (isRecording() ? stopSession() : openDashboard('record?new=1')),
  'CommandOrControl+Shift+Space': () => openDashboard('ask'),
}

export const init: ServiceInit = () => {
  const register = () => {
    for (const [accel, fn] of Object.entries(KEYS)) {
      const ok = globalShortcut.register(accel, () => {
        Promise.resolve(fn()).catch((err) => console.error(`[hotkeys] ${accel} failed:`, err))
      })
      if (!ok) console.warn(`[hotkeys] ${accel} is taken by another app`)
    }
  }
  if (app.isReady()) register()
  else app.whenReady().then(register)
  app.on('will-quit', () => globalShortcut.unregisterAll())
}
