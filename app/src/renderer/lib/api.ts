// Thin helpers over window.apprentice, usable from every window (overlay, panel, dashboard).
import { useEffect, useRef } from 'react'
import type { ApprenticeApi } from '../../preload/api'

const api = () => {
  const bridge = (window as Window & { apprentice?: ApprenticeApi }).apprentice
  if (!bridge) throw new Error('Desktop connection is unavailable.')
  return bridge
}

export function invoke<T = unknown>(channel: string, payload?: unknown): Promise<T> {
  return api().invoke<T>(channel, payload)
}

/** Like invoke, but resolves null (and logs) when nobody handles the channel yet. */
export async function tryInvoke<T = unknown>(channel: string, payload?: unknown): Promise<T | null> {
  try {
    return await api().invoke<T>(channel, payload)
  } catch (err) {
    console.warn(`[ipc] ${channel} failed:`, err)
    return null
  }
}

export function on<T = unknown>(channel: string, cb: (payload: T) => void): () => void {
  return api().on<T>(channel, cb)
}

/** Subscribe to a broadcast channel for the component's lifetime. The callback may change freely. */
export function useChannel<T = unknown>(channel: string, cb: (payload: T) => void) {
  const ref = useRef(cb)
  ref.current = cb
  useEffect(() => on<T>(channel, (p) => ref.current(p)), [channel])
}

/** URL for a file under %APPDATA%/apprentice (e.g. a step screenshot "shots/123.jpg"). */
export function shotUrl(path: string | null | undefined): string | undefined {
  return path ? `apx://file/?p=${encodeURIComponent(path)}` : undefined
}
