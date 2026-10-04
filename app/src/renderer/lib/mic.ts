// Which microphone the voice agent uses. The panel picks it, the overlay uses it; both windows share
// one origin, so localStorage (and its 'storage' event) is the channel. '' = the Windows default.
import { useEffect, useState } from 'react'

const KEY = 'apprentice.micDeviceId'

export const getMic = () => localStorage.getItem(KEY) ?? ''

export function setMic(deviceId: string) {
  if (deviceId) localStorage.setItem(KEY, deviceId)
  else localStorage.removeItem(KEY)
}

/** Calls back when another window changes the microphone. */
export function onMicChange(cb: (deviceId: string) => void) {
  const listener = (e: StorageEvent) => {
    if (e.key === KEY) cb(e.newValue ?? '')
  }
  window.addEventListener('storage', listener)
  return () => window.removeEventListener('storage', listener)
}

export interface Mic {
  deviceId: string
  label: string
}

/** Audio inputs, without Windows' "Default" / "Communications" alias entries. */
export async function listMics(): Promise<Mic[]> {
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices
    .filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
    .map((d) => ({ deviceId: d.deviceId, label: d.label || 'Microphone' }))
}

/** Name of the mic in use: the chosen one, or what Windows' default currently points at. */
export async function micLabel(deviceId = getMic()): Promise<string> {
  const devices = await navigator.mediaDevices.enumerateDevices()
  const d = devices.find((x) => x.kind === 'audioinput' && x.deviceId === (deviceId || 'default'))
  return d?.label.replace(/^Default - /, '') || 'Unknown microphone'
}

/** Keeps a list of microphones up to date as devices are plugged in or out. */
export function useMics() {
  const [mics, setMics] = useState<Mic[]>([])
  useEffect(() => {
    const refresh = () => void listMics().then(setMics).catch(() => setMics([]))
    refresh()
    navigator.mediaDevices.addEventListener('devicechange', refresh)
    return () => navigator.mediaDevices.removeEventListener('devicechange', refresh)
  }, [])
  return mics
}
