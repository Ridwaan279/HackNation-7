import type { GuideIpc } from '@shared/contracts'

export interface DashboardBridge {
  invoke<K extends keyof GuideIpc>(channel: K, payload: GuideIpc[K]['req']): Promise<GuideIpc[K]['res']>
  on(channel: string, callback: (payload: unknown) => void): () => void
}

export function desktopBridge(): DashboardBridge | undefined {
  return (window as Window & { apprentice?: DashboardBridge }).apprentice
}
