import { createRoot } from 'react-dom/client'
import Dashboard from '../app/src/renderer/dashboard'
import type { DashboardBridge } from '../app/src/renderer/dashboard/bridge'

const source = new EventSource('/events')
const listeners = new Map<string, Set<(value: unknown) => void>>()
source.onmessage = (event) => {
  const { channel, payload } = JSON.parse(event.data)
  for (const callback of listeners.get(channel) ?? []) callback(payload)
}
const bridge: DashboardBridge = {
  async invoke(channel, payload) {
    const response = await fetch('/ipc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel, payload }) })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error)
    return result
  },
  on(channel, callback) {
    const set = listeners.get(channel) ?? new Set()
    set.add(callback); listeners.set(channel, set)
    return () => { set.delete(callback) }
  },
}
createRoot(document.getElementById('root')!).render(<><div style={{ padding: '9px 32px', background: '#e5eee8', color: '#294334', font: '12px Segoe UI, sans-serif' }}>Fixture preview · Synthetic capture and model descriptions · Real guide editing, image redaction and Electron PDF export</div><Dashboard bridge={bridge}/></>)
