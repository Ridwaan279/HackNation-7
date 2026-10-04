# Agent B status (Shell, Voice and Ghost): M0 + Phase 3 pop-ups

Branch: `agent/b-shell`. Tested on Windows 11 at 150% scaling (2560×1600).

## Done
- **Scaffold** (`app/`): electron-vite 5 + React 19 + TS, deps from AGENT.md §3, `@shared` alias, `.env.example`.
  `npm run dev` opens the overlay, panel and dashboard. `npm run typecheck` and `npm run build` pass.
- **Bus + AppContext + service loader** (`src/main/index.ts`, `src/main/bus.ts`). Every `src/main/services/*.ts`
  with an `init` export is loaded automatically. A failing service is logged and skipped. `observer.ts` inits
  last, so every listener is attached before events flow. `bus.request` with no handler rejects with
  `NoHandlerError`.
- **Bus → windows forwarding:** these bus events are broadcast to every window on the channel of the same
  name: `guide:updated`, `workmap:updated`, `profile:updated`, `tutor:violation`, `popup:show`, `ghost:state`,
  `session:started`, `session:stopped`, `transcript:line`, `agent:answer`, and `observer:event` (except
  `activity` and `text`).
- **Screenshots in renderers:** `apx://file/?p=<path>` serves files under `%APPDATA%/apprentice` (relative
  paths resolve against it; nothing outside it is served). In the renderer, use `shotUrl(path)` from
  `src/renderer/lib/api.ts`.
- **Windows:** the overlay is transparent, click-through except over the ghost and bubble, `screen-saver`
  level, never takes focus, and refits on display changes. The panel and dashboard hide on close.
  Right-click the ghost for the menu (panel / dashboard / quit).
- **Ghost** (`src/renderer/mascot/Ghost.tsx`): one SVG, all 8 states, flying poses with speed lines, and the
  recording/vision badges. See them all on the dev dashboard.
- **Overlay:** drag the ghost to move it, click it to toggle the panel. It shows pop-up bubbles (≤3 buttons,
  12 s auto-dismiss, optional TTS) and agent captions. On `ghost:point` it flies on an arc and highlights the
  target. **Pointer verified at 150%:** a physical-px rect → `displays:toDip` fallback → lands exactly.
- **Voice:** `AgentHost` runs `@elevenlabs/react` v1 (`ConversationProvider`) in the overlay, driven by the
  `agent:command` channel from main. Conversation tokens are minted in main (`tts.ts`), so the API key never
  reaches a renderer. Agent prompts and tool schemas: `app/src/renderer/agents/README.md`.
- **session.ts:** teach / quick_guide / tutor sessions; `observer:mode` switching; teach Stop → waits for
  C's draft `workmap:updated` → Debrief agent (or press "Debrief now"); `teachback_confirmed` → hang up.
  Handles all 6 client tools. Transcripts and answer quotes go through `observer:redact`. Off the record
  pauses the sidecar, mutes the mic and marks the gap. Ghost state/badge come from `blocked`/`context` events.
  On `tutor:violation`: `[intervene]` nudge, ghost alert, fly to the last commit's field, panel replays
  `brain:stepsFor`.
- **gate.ts:** natural pause (action just finished + 3 s idle, or 8 s after a new screen; nobody speaking;
  budget) → `brain:pickQuestion` → `[pause]` nudge, also logged as a `transcript:line` with role `nudge`.
  Sends `sendUserActivity` while the expert is busy, and screen events as contextual updates.
- **Hotkeys:** `Ctrl+Shift+O` off the record, `Ctrl+Shift+R` record/stop, `Ctrl+Shift+Space` opens the
  panel (placeholder for "Ask the ghost").
- **Pop-ups** (`popups.ts`, a new B service):
  - **Accessibility-blind:** shown only when `a11y_health.prompt === true` (A decides when to ask). Choices
    Yes / Not now / Never, plus the Chromium tip and the "can't blur in vision mode" warning. Answered with
    `observer:a11yAck` (timeout → `later`).
  - **"Want to teach me <app>?"** after 2 minutes of foreground use in a new app, only when no session is
    running. Asked at most once a day per app; never again after Yes or Never. Yes starts a teach session.
    Never adds the app or domain to `privacy.json` (atomic write), then calls `observer:reloadConfig`.
    Offers are tracked in `%APPDATA%/apprentice/popups.json`.
  - **Warnings** (`sidecar_restarted`, `hook_restarted`, `uia_timeout`, `display_mismatch`, `dpi_unaware`)
    show as a short notice, at most once per 5 minutes per code.
  - The ghost flies in from the screen edge when a pop-up opens.
- **Integration check** (a throwaway merge of A + C + B, not committed): no merge conflicts, the merged tree
  typechecks, and all 10 services load with `observer` last. A fixture replay through A's `FakeReplay`
  showed the a11y pop-up, the throttled warning notice, not-watching on `blocked`, and the camera badge on
  `capture: vision`.
- **Panel:** watching status, Record / Quick guide / Stop / Off the record, live steps with screenshots,
  debrief controls, tutor replay slideshow.

## Stubbed / faked
- **Dashboard:** `#/dashboard` shows `src/renderer/devtools/DevDashboard.tsx` (ghost gallery, pop-up and
  pointer test buttons, live event log) until **C's `src/renderer/dashboard/index.tsx`** (default export) is merged, with a
  default export. That's picked up automatically and nothing in my files needs to change.
- **No `observer:redact`** (A not merged): `session.ts` uses an over-eager regex fallback (IBAN-like,
  12+ digit runs, common key prefixes). Replace it with A's handler as soon as A's handler is merged.
- **No `displays:toDip`:** falls back to `screen.screenToDipRect` (the same call A will make).
- **No `brain:pickQuestion`:** gate sends a generic `[pause]` question instead.
- **Not tested yet:** a live ElevenLabs conversation (no agent IDs or keys in `.env` yet), and the debrief
  and tutor flows end to end.
- **Not done:** the "Ask the ghost" hotkey, MediaRecorder video, the pointer self-test (Start button), first-run wizard.

## Needs from others
- **A:** nothing blocking. Your notes answered my questions: shot paths are relative to `ctx.paths.root`,
  which `apx://` serves. I cherry-picked your two `contracts:` commits so `popups.ts` compiles. They are
  identical to yours, so the merge is clean.
- **A, a fake-mode detail:** `FakeReplay` answers `redact` with the text unchanged. That's fine for
  fixtures, but it means my over-eager fallback masking never runs in fake mode.
- **C:**
  - `Guide.session` must be set; the panel and debrief match on it.
  - Emit a **draft** `workmap:updated` after `session:stopped`; that starts the debrief.
  - `WorkMapStep.reason` is a `Quote` (`.text`), even though PLAN §7's JSON shows `reason.quote`.
    I followed the contract.
  - Optional: register an IPC `workmaps:list` → `WorkMap[]` to get a "Start a lesson…" picker in the panel.
    Your Lessons page can also call `invoke('session:start', {kind:'tutor', workmap_id})`.
- **Everyone, time base:** I stamp `transcript:line.t`, `agent:answer.t` and `teachback_confirmed.t` with
  **epoch seconds** (`Date.now()/1000`), the same as sidecar events. PLAN's guide/workmap examples look
  session-relative (`t: 192.4`). Agree on one before M1.
- **Humans:** create the 3 ElevenLabs agents (`app/src/renderer/agents/README.md`) and fill in `app/.env`.

## Known bugs / gotchas
- **`npm run dev` from a VS Code extension-spawned shell** inherits `ELECTRON_RUN_AS_NODE=1`, so Electron
  runs as plain Node and crashes (`app` is undefined). Unset it (`env -u ELECTRON_RUN_AS_NODE npm run dev`)
  or use a normal terminal.
- npm 11 skipped Electron's binary download, so I added a `postinstall` that runs `electron/install.js`.
- Version pins: `@vitejs/plugin-react@6` needs Vite 8, but `electron-vite@5` supports only Vite ≤7, so I
  pinned Vite 7 and plugin-react 5. TypeScript resolved to 7 (the native port), so the tsconfigs don't use
  `baseUrl`.
- **Two app instances on one desktop interfere.** During my test, another checkout's Electron
  (`Codex_coding/…`) was running at the same time. Both apps put the ghost and panel in the same spots,
  share `%APPDATA%/apprentice`, and compete for the global hotkeys. Stray clicks started a session in my
  instance. Only one agent should do GUI testing at a time.
- `GATE_MIN_GAP_S` defaults to **45 s** (**needs a human decision**: C asked that the gate not change silently), not PLAN's 90 s: M1 needs ≥3 questions in 3 minutes.
- `GHOST_CONTENT_PROTECTION=1` hides the ghost from *all* capture, including OBS and Zoom, so it's off by
  default. Turn it on only after the backup video is recorded.
- The overlay covers the primary display only, so the ghost can't point at windows on a second monitor.
