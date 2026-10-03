// Shared contracts for the AI Apprentice.
// Single source of truth for data passed between the Python sidecar, the
// Electron main-process services and the renderer windows.
// Rules (see AGENT.md): additive changes only, never rename or remove a field,
// and commit contract changes on their own ("contracts: ...").
// The Python sidecar emits exactly these JSON shapes.

// ---------------------------------------------------------------- primitives

/** [left, top, right, bottom] in PHYSICAL screen pixels unless a name says otherwise. */
export type Rect = [number, number, number, number]
export type DpiAwareness = 'unaware' | 'system' | 'per_monitor' | 'unknown'
export type Mode = 'ambient' | 'session' | 'tutor' | 'paused'
export type CaptureMode = 'uia' | 'vision'
export type A11yStatus = 'ok' | 'weak' | 'blind'
export type BlockReason =
  | 'password_manager'
  | 'banking'
  | 'private_window'
  | 'system'
  | 'user_blocked'
  | 'paused'
  | 'off_record'
  | 'self'

/** How a screenshot maps back to the screen: screen_px = origin_px + image_px / scale. */
export interface ShotMeta {
  origin_px: [number, number]
  size_px: [number, number]
  scale: number
  monitor: number
  /** false when sensitive fields could not be blurred automatically (vision-mode apps). */
  auto_blur?: boolean
}

export interface Monitor {
  id: number
  rect_px: Rect
  work_px: Rect
  dpi: number
  scale: number
  primary: boolean
}

export interface UiTarget {
  name: string
  control_type: string
  automation_id: string
  rect: Rect
  /** false when the click point fell outside the reported rect (bad app scaling). */
  rect_trusted: boolean
}

export interface UiControl {
  name: string
  control_type: string
  automation_id: string
  rect: Rect
}

// ------------------------------------------------ sidecar → main (stdout lines)

export interface ContextEvent {
  type: 'context'
  t: number
  app: string
  /** Lowercase process name, or "browser:<domain>" for web apps. */
  key: string
  title: string
  blocked: false
  hwnd: number
  monitor: number
  window_rect: Rect
  dpi_awareness: DpiAwareness
  window_dpi: number
  monitor_scale: number
  capture: CaptureMode
}

/** Emitted instead of ContextEvent for skipped/blocked windows. Nothing else is reported. */
export interface BlockedEvent {
  type: 'blocked'
  t: number
  reason: BlockReason
}

export interface ClickEvent {
  type: 'click'
  t: number
  x: number
  y: number
  button: 'left' | 'right' | 'middle'
  target: UiTarget | null
  shot: string | null
  shot_meta: ShotMeta | null
}

export interface CommitEvent {
  type: 'commit'
  t: number
  field: string
  old: string
  new: string
  rect: Rect | null
  masked: boolean
  source: 'uia' | 'vision'
  /** true when the user left the field or pressed Enter/Tab; false for an idle (0.8 s) commit that may still change. */
  final?: boolean
}

export interface KeyEvent {
  type: 'key'
  t: number
  key: 'enter' | 'tab' | 'esc' | 'ctrl+s' | 'ctrl+enter'
}

/** Throttled, content-free input timing. */
export interface ActivityEvent {
  type: 'activity'
  t: number
  kind: 'typing' | 'mouse' | 'scroll'
}

/** Ambient text: masked, only lines new since the last snapshot of that window. */
export interface TextEvent {
  type: 'text'
  t: number
  key: string
  title: string
  delta: string[]
}

/** Periodic / on-demand screenshot. ephemeral = describe it, then delete the file. */
export interface ShotEvent {
  type: 'shot'
  t: number
  key: string
  path: string
  reason: 'heartbeat' | 'ambient' | 'vision_mode' | 'on_demand'
  meta: ShotMeta
  ephemeral: boolean
}

export interface DisplaysEvent {
  type: 'displays'
  t: number
  monitors: Monitor[]
}

export interface A11yHealthEvent {
  type: 'a11y_health'
  t: number
  key: string
  status: A11yStatus
  reasons: string[]
  score: { named_elements: number; text_chars: number; click_resolution: number }
  /** Suggested fix the pop-up can offer, e.g. relaunch a Chromium browser with the a11y flag. */
  hint?: 'chromium_flag' | 'remote_session' | 'none'
  /** true when the "screen record instead?" pop-up should be shown (not asked in the last 24 h, not "never"). */
  prompt?: boolean
}

export interface AppScalingEvent {
  type: 'app_scaling'
  t: number
  key: string
  status: 'ok' | 'corrected' | 'untrusted'
  /** Correction factor (status = corrected). The sidecar already applies it to every rect it emits; informational. */
  rect_scale?: number
  /** What the correction scales around: the screen origin or the window's monitor origin. */
  rect_anchor?: 'screen' | 'monitor'
}

export interface WarningEvent {
  type: 'warning'
  t: number
  code: 'dpi_unaware' | 'hook_restarted' | 'uia_timeout' | 'rect_mismatch' | 'sidecar_restarted' | 'display_mismatch'
  detail?: string
}

/** First line the sidecar prints after starting. */
export interface ReadyEvent {
  type: 'ready'
  t: number
  version: string
  platform: string
  backend: 'windows' | 'fake'
  dpi_awareness: DpiAwareness
}

export type SidecarEvent =
  | ReadyEvent
  | ContextEvent
  | BlockedEvent
  | ClickEvent
  | CommitEvent
  | KeyEvent
  | ActivityEvent
  | TextEvent
  | ShotEvent
  | DisplaysEvent
  | A11yHealthEvent
  | AppScalingEvent
  | WarningEvent

// ------------------------------------------------- main → sidecar (stdin lines)

export type SidecarCommand =
  | { id: number; cmd: 'redact'; text: string }
  | { id: number; cmd: 'tree'; max: number }
  | { id: number; cmd: 'mode'; value: Mode }
  | { id: number; cmd: 'shot'; reason: 'on_demand' }
  | { id: number; cmd: 'set_capture'; key: string; value: CaptureMode }
  | { id: number; cmd: 'reload_config' }
  /** Answer to the a11y pop-up: yes = vision mode, later = ask again in 24 h, never = block the app. */
  | { id: number; cmd: 'a11y_ack'; key: string; choice: 'yes' | 'later' | 'never' }

/** Every reply echoes the command id. Extra fields depend on the command. */
export interface SidecarReply {
  id: number
  ok: boolean
  error?: string
  text?: string
  controls?: UiControl[]
  path?: string
  meta?: ShotMeta
}

// ------------------------------------------------------------ stored documents

export interface TranscriptLine {
  t: number
  role: 'expert' | 'newhire' | 'agent' | 'nudge'
  /** Already redacted. */
  text: string
}

export interface Answer {
  t: number
  question: string
  answer_quote: string
  type: 'reason' | 'guardrail' | 'exception'
  related_event_t?: number
  source: 'live' | 'debrief'
}

export interface Quote {
  text: string
  t: number
  source?: 'live' | 'debrief'
}

export interface GuideStep {
  id: string
  n: number
  t: number
  kind: 'enter' | 'click' | 'select' | 'switch' | 'note'
  title: string
  note: string
  target: string
  value?: string
  shot: string | null
  highlight: Rect | null
  blur: Rect[]
  screen_moment: string
  quote?: Quote
  edited: boolean
}

export interface Guide {
  id: string
  title: string
  app: string
  session: string
  steps: GuideStep[]
}

export interface Guardrail {
  id: string
  type: 'limit' | 'exception' | 'stop_and_ask'
  rule: string
  quote: string
  t: number
  source: 'live' | 'debrief'
}

export interface WorkMapStep {
  id: string
  index: number
  title: string
  guide_steps: string[]
  t_start: number
  t_end: number
  decision: string
  reason: Quote
  guardrails: Guardrail[]
  judgment_call: boolean
}

export interface WorkMap {
  id: string
  role: string
  expert: string
  status: 'draft' | 'confirmed'
  guide: string
  video?: string
  steps: WorkMapStep[]
  open_questions: string[]
  teachback: { confirmed: boolean; t?: number; corrections: { step_id: string; quote: string }[] }
}

export interface AppProfile {
  key: string
  name: string
  minutes: number
  last_seen: string
  purpose: string
  recurring_tasks: { name: string; evidence: number }[]
  screens_fields: string[]
  patterns: string[]
  exceptions: string[]
  open_questions: string[]
  expert_quotes: { q: string; a: string; t: string }[]
  today: string[]
  guides: string[]
  workmaps: string[]
}

export interface PrivacyConfig {
  mask: { passwords: boolean; secrets: boolean; cards: boolean; ssn: boolean; iban: boolean; email: boolean; phone: boolean }
  skip: { banking: boolean; password_managers: boolean; private_windows: boolean }
  blocked_apps: string[]
  blocked_domains: string[]
  allow_only: string[] | null
  raw_retention_days: number
  local_only_apps: string[]
  ambient_screenshots: boolean
}

/** Runtime app_modes.json (%APPDATA%/apprentice/config/), keyed by app key. Written after a11y / scaling detection. */
export interface AppModes {
  [appKey: string]: {
    capture: CaptureMode
    rect_scale?: number
    rect_anchor?: 'screen' | 'monitor'
    a11y_prompted_at?: string
    never_ask?: boolean
  }
}

// ------------------------------------------------------------- agent & tutor

export interface PickedQuestion {
  question: string
  type: 'reason' | 'guardrail' | 'exception'
  about_event_t: number
}

export interface Violation {
  session: string
  step_id: string
  guardrail_id: string
  why: string
  quote: Quote
}

export interface Popup {
  id: string
  kind: 'teach_app' | 'a11y_blind' | 'curiosity' | 'info' | 'warning'
  app_key?: string
  text: string
  speak: boolean
  choices: { id: string; label: string }[]
  timeout_s?: number
}

export type GhostState =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'flying'
  | 'pointing'
  | 'alert'
  | 'not_watching'

// -------------------------------------------------------- main-process wiring

/** Events on the in-process bus (main process). */
export interface BusEvents {
  'observer:event': SidecarEvent
  'session:started': { id: string; kind: 'teach' | 'quick_guide' | 'tutor'; workmap_id?: string }
  'session:stopped': { id: string }
  'transcript:line': TranscriptLine & { session: string }
  'agent:answer': Answer & { session: string }
  'agent:correction': { session: string; step_id: string; correction_quote: string }
  'agent:teachback_confirmed': { session: string; t: number }
  'tutor:mark_step': { session: string; step_id: string; outcome: 'alone' | 'hint' | 'caught' }
  'guide:updated': Guide
  'workmap:updated': WorkMap
  'profile:updated': AppProfile
  'tutor:violation': Violation
  'popup:show': Popup
  'popup:answer': { id: string; choice: string }
  'ghost:state': { state: GhostState; badge?: 'recording' | 'vision' | null }
}

/** Request/response handlers on the bus. Owner in brackets. */
export interface BusRequests {
  'observer:redact': { req: { text: string }; res: { text: string } } // [A]
  'observer:tree': { req: { max: number }; res: { controls: UiControl[] } } // [A]
  'observer:mode': { req: { value: Mode }; res: { ok: boolean } } // [A]
  'observer:shot': { req: Record<string, never>; res: { path: string; meta: ShotMeta } } // [A]
  'observer:setCapture': { req: { key: string; value: CaptureMode }; res: { ok: boolean } } // [A]
  'observer:a11yAck': { req: { key: string; choice: 'yes' | 'later' | 'never' }; res: { ok: boolean } } // [A]
  'displays:toDip': { req: { rect: Rect }; res: { rect: Rect } } // [A]
  'brain:pickQuestion': { req: { session: string }; res: PickedQuestion | null } // [C]
  'brain:locate': { req: { target: string }; res: { rect: Rect; source: 'uia' | 'vision' } | null } // [C]
  'brain:stepsFor': { req: { workmap_id: string; step_id: string }; res: GuideStep[] } // [C]
  'brain:workmap': { req: { id: string }; res: WorkMap | null } // [C]
  'brain:guide': { req: { id: string }; res: Guide | null } // [C]
}

export interface Bus {
  emit<K extends keyof BusEvents>(name: K, payload: BusEvents[K]): void
  on<K extends keyof BusEvents>(name: K, fn: (payload: BusEvents[K]) => void): () => void
  handle<K extends keyof BusRequests>(
    name: K,
    fn: (req: BusRequests[K]['req']) => Promise<BusRequests[K]['res']> | BusRequests[K]['res']
  ): void
  request<K extends keyof BusRequests>(name: K, req: BusRequests[K]['req']): Promise<BusRequests[K]['res']>
}

/** Passed to every main-process service: `export const init: ServiceInit = (ctx) => { ... }` */
export interface AppContext {
  bus: Bus
  paths: { root: string; sessions: string; memory: string; config: string; shots: string }
  env: { MODEL_FAST: string; MODEL_SMART: string; OBSERVER_FAKE?: string }
  /** Renderer → main (ipcMain.handle). Channel names: "<area>:<verb>", e.g. "guides:list". */
  handle(channel: string, fn: (payload: any) => unknown): void
  /** Main → every window. */
  broadcast(channel: string, payload: unknown): void
}

export type ServiceInit = (ctx: AppContext) => void | Promise<void>
