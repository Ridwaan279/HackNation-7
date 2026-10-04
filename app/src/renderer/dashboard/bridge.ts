import type { AppModes, AppProfile, CaptureMode, GuideIpc, MasteryReport, MemoryApp, MemoryEntry, PrivacyConfig, WorkMap } from '@shared/contracts'

export interface Settings { role: string; expert: string; onboarded: boolean }
export interface PrivacyState { privacy: PrivacyConfig; app_modes: AppModes; paused_until: number | null }
type Empty = Record<string, never>

/** Every channel the dashboard uses (main-process handlers in app/src/main/services). */
export interface DashboardIpc extends GuideIpc {
  'workmaps:list': { req: Empty; res: WorkMap[] }
  'workmap:get': { req: { id: string }; res: WorkMap | null }
  'profiles:list': { req: Empty; res: AppProfile[] }
  'profile:refresh': { req: { key: string }; res: AppProfile | null }
  'profile:answer': { req: { key: string; question: string; answer: string }; res: AppProfile }
  'memory:list': { req: Empty; res: MemoryApp[] }
  'memory:day': { req: { key: string; day: string }; res: MemoryEntry[] }
  'memory:delete': { req: { key?: string; day?: string }; res: MemoryApp[] }
  'data:deleteAll': { req: Empty; res: { ok: boolean } }
  'privacy:get': { req: Empty; res: PrivacyState }
  'privacy:set': { req: PrivacyConfig; res: PrivacyState }
  'privacy:setCapture': { req: { key: string; value: CaptureMode }; res: PrivacyState }
  'privacy:pause': { req: { minutes: number | 'tomorrow' }; res: PrivacyState }
  'privacy:resume': { req: Empty; res: PrivacyState }
  'settings:get': { req: Empty; res: Settings }
  'settings:set': { req: Partial<Settings>; res: Settings }
  'mastery:list': { req: Empty; res: MasteryReport[] }
  'session:start': { req: { kind: 'teach' | 'quick_guide' | 'tutor'; workmap_id?: string }; res: unknown }
}

export interface DashboardBridge {
  invoke<K extends keyof DashboardIpc>(channel: K, payload: DashboardIpc[K]['req']): Promise<DashboardIpc[K]['res']>
  on(channel: string, callback: (payload: unknown) => void): () => void
}

export function desktopBridge(): DashboardBridge | undefined {
  return (window as Window & { apprentice?: DashboardBridge }).apprentice
}

export const errorText = (failure: unknown, fallback = 'Operation failed. Try again.') =>
  failure instanceof Error ? failure.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : fallback

/** App keys as people read them: "browser:minierp.local" → "minierp.local", "excel.exe" → "Excel". */
export function appLabel(key: string): string {
  if (key.startsWith('browser:')) return key.slice(8).replace(/^www\./, '')
  return key.replace(/\.exe$/i, '').replace(/^./, (c) => c.toUpperCase())
}

export const when = (iso: string | number) => {
  const date = typeof iso === 'number' ? new Date(iso * 1000) : new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}
