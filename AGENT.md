# AI Apprentice: instructions for coding agents

This file is for every coding-agent session working in this repo, whether it's Claude Code, Codex or another tool. `CLAUDE.md`, `CODEX.md` and `AGENTS.md` only point here.

> **Current mode (since 2026-10-04): one agent, on `main`.** The three agent branches were merged into `main` (A → C → B) and the split ended. One agent now works across the whole repo and commits to `main`. The ownership table (§3), merge points (§5) and status files (§6) are kept below as history. The privacy rules and code rules 4, 6, 7 and 8 still apply. What exists now and how to check it: **`docs/STATUS.md`**.

Originally, **three agents built in parallel**, each on its own branch and in its own folders, and their work was merged at fixed merge points.

- **Product spec and design decisions:** `docs/PLAN.md` (§ numbers below refer to it). Read it before writing code.
- **Shared data types:** `shared/contracts.ts`. Every message between the sidecar, the main process and the windows is defined there.
- **Mascot reference:** `assets/mascot/ghost-reference.webp` (the spec is in PLAN §5.10).

When you start a session, the human tells you which agent you are, for example:
`You are Agent A (Observer). Read AGENT.md and docs/PLAN.md, then start Phase 1.`
Stay inside your agent's role and file ownership.

---

## 1. What we're building (30-second version)

The AI Apprentice is a Windows desktop app: an Electron shell plus a Python sidecar.
- **Expert side:** it watches how an expert works (text through Windows Accessibility, and screenshots on clicks). It asks *why* at natural pauses through an ElevenLabs voice agent, and builds an editable step guide and a Work Map of decisions and guardrails.
- **New-hire side:** it coaches a new hire on their own screen and catches mistakes before they're saved.
- **Always on:** it learns each app 24/7 as masked text and summarizes it into App Profiles.
- **Mascot:** a glowing ghost that floats on screen, talks, and flies to the button you need.

There are three judged modules: **Capture**, **Map** and **Teach** (PLAN §2).

---

## 2. Rules every agent follows

**Privacy (never break these):**
1. Nothing raw leaves the sidecar. The order is always privacy gate → `redact.py` → emit. Voice transcripts also go through `observer:redact` before they're stored.
2. Never read password fields (`IsPassword` or password-like names). Never store printable keystrokes. Never capture in skipped or blocked apps, or while paused or off the record.
3. Ambient screenshots are *ephemeral*: describe them, then delete the file. Only teach sessions keep screenshots.

**Code:**

4. API keys stay in the main process (`app/.env`). Model names come from `MODEL_FAST` and `MODEL_SMART` env vars, never hard-coded.
5. *(Three-agent mode only.)* Edit only the paths your agent owns (§3). If you need something from another agent's area, write a stub on your side and note it in your status file (§6).
6. `shared/contracts.ts` changes must be **additive only**: add optional fields, new event types or new channels. Never rename or remove anything. Commit contract changes on their own (`contracts: add X`) so merges stay trivial.
7. Keep it simple: this is a 10-hour hackathon. No new frameworks, no state libraries, no ORMs. Store JSON and JSONL files under `%APPDATA%/apprentice`.
8. This is Windows-only. Code that touches the OS gets tested on a Windows machine. In a Linux or cloud session, build only the platform-neutral parts and say what's untested.
9. Small commits with clear messages. *(Three-agent mode: don't push to `main` yourself; the integrator merges, §5. Single-agent mode: commit to `main`.)*

---

## 3. Repo layout and ownership

| Path | Owner | What |
|---|---|---|
| `sidecar/**` | **A** | Python observer: hooks, UI Automation, privacy, redaction, screenshots, display/DPI, accessibility health |
| `config/**` | **A** | Repo defaults: `privacy.default.json`, `skiplists.json`, `app_modes.default.json`. On first run the sidecar copies them into the runtime config folder, `%APPDATA%/apprentice/config/` (`privacy.json`, `app_modes.json`) |
| `app/src/main/services/observer.ts` | **A** | Spawns the sidecar, JSON-lines protocol, restart on crash, `OBSERVER_FAKE` replay mode, handles `observer:*` requests |
| `app/src/main/services/displays.ts` | **A** | Physical px ↔ DIP conversion (`displays:toDip`), monitor matching |
| `app/` scaffold: `package.json`, `electron.vite.config.ts`, `tsconfig*`, `src/main/index.ts`, `src/preload/**` | **B** | Electron app, window creation, service loader, bus, generic preload API |
| `app/src/main/services/{gate,tts,hotkeys,windows,session}.ts` | **B** | Natural-pause gate, ElevenLabs TTS, hotkeys, window management, session lifecycle |
| `app/src/renderer/overlay/**`, `app/src/renderer/panel/**`, `app/src/renderer/mascot/**`, `app/src/renderer/agents/**` | **B** | Ghost mascot, pop-ups, pointer, side panel, ElevenLabs agents and client tools |
| `app/src/main/services/{llm,store,steps,memory,rollup,workmap,checker,mastery,describe,locate}.ts` | **C** | All LLM pipelines and storage |
| `app/prompts/**` | **C** | Prompt files |
| `app/src/renderer/dashboard/**` | **C** | Guide editor, Work Map, App Profiles, Memory, Privacy, Mastery pages |
| `sandbox-erp/**`, `fixtures/**` | **C** | MiniERP demo app, fake event streams |
| `shared/contracts.ts` | shared | Additive changes only (rule 6) |
| `docs/agents/<a\|b\|c>.md` | each agent | Status notes at every merge |
| `AGENT.md`, `CLAUDE.md`, `CODEX.md`, `AGENTS.md`, `docs/PLAN.md` | humans | Ask before changing |

`app/` uses the standard electron-vite layout (`src/main`, `src/preload`, `src/renderer`). It has **one renderer with hash routes**: `#/overlay`, `#/panel` and `#/dashboard`. Import shared types via the alias `@shared/contracts`.

**Dependencies:** Agent B installs these at scaffold time, so the others don't need to touch `package.json`:
`electron`, `electron-vite`, `react`, `react-dom`, `typescript`, `@elevenlabs/react`, `@anthropic-ai/sdk`, `zod`, `framer-motion`, `dotenv`.
If you need another one, commit it as a separate `deps: add X` commit touching only `package.json`, and mention it in your status file. B resolves any conflicts.

Python dependencies (A): `uiautomation`, `pynput`, `mss`, `Pillow`, `pytest`.

---

## 4. How the pieces talk (integration contract)

```
sidecar (A) ──stdout JSON lines──▶ observer.ts (A) ──bus 'observer:event'──▶ services (B, C)
           ◀──stdin commands────── observer.ts      ◀──bus.request('observer:*')── services
main services ──ctx.broadcast(channel)──▶ windows      windows ──invoke(channel)──▶ ctx.handle (main)
```

- **Service shape:** every main-process service file exports `export const init: ServiceInit = (ctx) => { … }`. B's `index.ts` calls every service's `init` at startup. Until a service exists, B's loader simply skips it, so nobody waits on anyone.
- **Bus:** events (`bus.emit` / `bus.on`) and request/response (`bus.handle` / `bus.request`), with exact names and payloads in `BusEvents` and `BusRequests`. Each request has a single owner, marked `[A]` or `[C]` in the contracts.
- **Renderer IPC:** the preload exposes `window.apprentice.invoke(channel, payload)` and `window.apprentice.on(channel, cb)`. Channels are named `<area>:<verb>` (`guides:list`, `guide:save`, `privacy:set`, `memory:delete`, `session:start`, `agent:tool`). Whoever owns the area registers it with `ctx.handle`.
- **Client tools:** the ElevenLabs SDK runs in the overlay renderer (B). Each tool calls `invoke('agent:tool', {name, args})`, and B's main handler turns that into bus events (`agent:answer`, `agent:correction`, …) that C consumes.
- **Fake mode:** with `OBSERVER_FAKE=fixtures/<file>.jsonl`, `observer.ts` replays a fixture instead of spawning Python. B and C use this until the first merge.

---

## 5. Branches, worktrees and merge points

**Setup** (once, by a human):
```bash
# base = main containing this file, docs/PLAN.md and shared/contracts.ts
git checkout main && git pull
# agent/a-observer already exists on origin (Agent A's work has started there),
# so check it out instead of creating it:
git worktree add ../hn-a agent/a-observer
git worktree add ../hn-b -b agent/b-shell
git worktree add ../hn-c -b agent/c-brain
# open one agent session (Claude Code or Codex) in each worktree
```

The **integrator** is one human; Agent B can help resolve conflicts. At each merge point:
1. Each agent finishes its current task, runs its own checks, updates `docs/agents/<x>.md`, commits and pushes.
2. The integrator merges into `main` **in order A → C → B**. B goes last because it owns the wiring in `index.ts`.
3. The integrator runs the smoke test for that merge point (below) on a Windows machine and fixes small breakages directly on `main`.
4. Every agent runs `git merge main` into its branch and continues.

| Merge | Time | Who merges | Smoke test (must pass on Windows) |
|---|---|---|---|
| **M0** | 0:45 | B only | `npm run dev` in `app/` opens the overlay, panel and dashboard. The ghost renders. You can talk to the Interviewer agent from the overlay |
| **M1** | 3:00 | A → C → B | Real clicks in MiniERP produce masked steps with screenshots in the panel and guide editor. In a 3-minute task the agent asks ≥3 questions at pauses, ≥1 about a guardrail. A password field is never read |
| **M2** | 5:30 | A → C → B | Stop → debrief (≥3 questions + teach-back) → confirmed Work Map linked to guide steps. App Profiles exist for 3+ apps. The ghost shows "not watching" in a password manager. A browser with accessibility off triggers the "screen record instead?" pop-up. Correct pointer position at 100% and 150% scaling |
| **M3** | 7:45 | A → C → B | The new hire's €7,200 opex mistake is caught before Post, explained in Sabine's words, with her screenshots replayed. The ghost flies to the field. The mastery report shows. **Feature freeze at 8:00** |
| **M4** | 9:15 | anyone, small PRs | Release candidate: bug fixes only. Full demo script (PLAN §14) runs 3 times |

If a smoke test fails, spend at most 30 minutes fixing it on `main`. If it's still failing, cut the feature (PLAN §9 says what's optional) and move on.

---

## 6. Status files

At every merge point, each agent overwrites `docs/agents/<a|b|c>.md` with:
- **Done:** what works, with how to see it.
- **Stubbed / faked:** what's stubbed or faked, and what real thing it's waiting for.
- **Needs from others:** exact bus request, IPC channel or contract field.
- **Known bugs.**

Read the other two status files right after each `git merge main`.

---

## 7. Agent A: Observer

**Mission:** be the app's eyes, safely. Everything the app knows about the screen comes through you, already masked.

**Owns:** `sidecar/**`, `config/**`, `app/src/main/services/observer.ts`, `app/src/main/services/displays.ts`.

**Phase 1 (0:00–0:45): spike.** Write the go/no-go results to `docs/agents/a.md`.
- [ ] Set the process to per-monitor DPI-aware v2 (fallback `SetProcessDpiAwareness(2)`), and check it took effect.
- [ ] pynput mouse-down → `ControlFromPoint(x, y)` gives the element name and type in MiniERP running in Edge.
- [ ] Read `IsPassword` on a password input. Read the Edge URL from the address-bar element.
- [ ] Use `mss` to grab only the foreground window's rect.
- [ ] If web content is empty, retry with Edge launched using `--force-renderer-accessibility` and record the result.

**Phase 2 (0:45–3:00): core pipeline → M1.**
- [ ] `observer.py`: JSON lines on stdout, commands on stdin, replies echo the `id`. Hook thread → queue → worker thread (`UIAutomationInitializerInThread`). Hook callbacks do nothing but enqueue.
- [ ] Emit `context` / `blocked` every 500 ms on change.
- [ ] Emit `commit` when a field loses focus or after 0.8 s idle.
- [ ] Emit `key` (control keys only) and throttled `activity` events.
- [ ] `click`: element under the cursor, window-only screenshot, ring at the click point, box around the element, password and masked fields blurred, `shot_meta` filled in.
- [ ] `privacy.py`: skip lists (password managers, banking, private windows, system dialogs, our own process), user block lists, allow-only mode, pause and off-the-record.
- [ ] `redact.py` and `tests/test_redact.py` (PLAN §6.1 rules and test vectors). Answer the `redact` command.
- [ ] `observer.ts`: spawn `python sidecar/observer.py`, parse lines into `SidecarEvent`, emit `observer:event`, handle `observer:*` requests, restart on crash (emit `warning: sidecar_restarted`), and support `OBSERVER_FAKE` replay.
- [ ] `displays.ts`: implement `displays:toDip` with Electron `screen.screenToDipRect`.

**Phase 3 (3:00–5:30): scaling, accessibility health, ambient → M2.**
- [ ] `display.py`: emit `displays` at start and on change (poll every 5 s). Add per-window `dpi_awareness`, `window_dpi`, `monitor_scale` and `monitor` to `context`.
- [ ] Rect check on every click. On repeated mismatch, try a correction factor (×scale or ÷scale), then emit `app_scaling` (corrected / untrusted) and save it to the runtime `app_modes.json` (PLAN §5.7).
- [ ] `health.py`: score per app (named elements, text characters, click resolution, Chromium empty-document check, remote-session process names). Emit `a11y_health` with status `blind` and a `hint` (PLAN §5.8).
- [ ] Ambient text snapshots: caps from PLAN §5.2, masking, only new lines → `text` events.
- [ ] Screenshots (PLAN §5.9):
  - [ ] heartbeat `shot` every 5 s in session/tutor mode when the screen changed (2 s in vision mode);
  - [ ] ambient `shot` every 60 s when changed (`ephemeral: true`);
  - [ ] the `shot` command for on-demand captures;
  - [ ] the `set_capture` command to switch an app to vision mode.

**Phase 4 (5:30–7:45): pointer support and hardening → M3.**
- [ ] `tree` command: controls with rects for the foreground window (max 300, 1.5 s budget), with `rect_scale` corrections applied.
- [ ] Vision-mode apps: click screenshots without element data, no automatic blur (flag it in the event), faster heartbeat.
- [ ] Watchdog: if input activity stops arriving while the mouse is moving, reinstall the hooks and emit `warning: hook_restarted`.
- [ ] Performance caps and timeouts for slow trees (Excel, large pages).

**Phase 5 (7:45–10:00):** bug fixes, then go through every app in the Memory page with a human and check for leaks.

---

## 8. Agent B: Shell, Voice and Ghost

**Mission:** be the app's body and voice. The Electron shell, the ghost on screen, and the ElevenLabs agents that talk at the right moment.

**Owns:**
- the `app/` scaffold: `package.json`, `electron.vite.config.ts`, `tsconfig*`, `src/main/index.ts`, `src/preload/**`;
- `app/src/main/services/{gate,tts,hotkeys,windows,session}.ts`;
- `app/src/renderer/{overlay,panel,mascot,agents}/**`.

**Phase 1 (0:00–0:45): scaffold → M0.**
- [ ] Create the electron-vite React + TS project in `app/` with the dependencies from §3 and the `@shared` alias. `.env.example` lists `ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY`, `VITE_AGENT_INTERVIEWER`, `VITE_AGENT_DEBRIEF`, `VITE_AGENT_TUTOR`, `MODEL_FAST`, `MODEL_SMART` and `OBSERVER_FAKE`.
- [ ] `index.ts`: typed bus implementing `Bus`, an `AppContext` instance, and a service loader that calls `init` on every file in `src/main/services/` that exists.
- [ ] Windows:
  - [ ] overlay: fullscreen, transparent, click-through via `setIgnoreMouseEvents(true, {forward:true})`, always on top at `screen-saver` level;
  - [ ] panel;
  - [ ] dashboard.
- [ ] Generic preload (`invoke`, `on`). Permission handlers for the microphone and display media.
- [ ] First version of the ghost as an SVG component (PLAN §5.10). Overlay hosts `useConversation` and talks to the Interviewer agent.
- [ ] Create the 3 agents in the ElevenLabs dashboard (PLAN §7: `skip_turn`, Expressive Mode, `{{role}}`, overrides enabled, client tool names).

**Phase 2 (0:45–3:00): Interviewer → M1.**
- [ ] Ghost states: idle (bob and blink), listening, thinking, speaking (glow follows the agent's output volume), flying (tilt and speed lines). Make the overlay clickable only over the ghost and its bubble.
- [ ] `session.ts`: start/stop teach sessions; emit `session:started` / `session:stopped`; switch the observer mode.
- [ ] `gate.ts`: natural pause from `activity`/`commit`/`click` events plus speaking state plus question budget (PLAN §5.3). Calls `sendUserActivity()` while the user is busy. At a pause, requests `brain:pickQuestion` and sends the `[pause]` nudge.
- [ ] Push meaningful events into the agent with `sendContextualUpdate`.
- [ ] Client tool `record_answer` → `agent:answer`. Transcripts go through `observer:redact`, then `transcript:line`.
- [ ] Panel: live guide steps (listens to `guide:updated`), Record/Stop, and watching status.

**Phase 3 (3:00–5:30): debrief, pop-ups, states → M2.**
- [ ] Debrief flow: start the Debrief agent with the open questions from `brain:workmap`. Client tools `record_correction` and `teachback_confirmed`.
- [ ] Pop-up system: speech bubble next to the ghost with ≤3 buttons; handles `popup:show`, answers with `popup:answer`; optional speech through `tts.ts`. Used for:
  - [ ] "Want to teach me this app?" (first 2+ minutes in a new app);
  - [ ] the accessibility-blind pop-up from `a11y_health` events: "I can't read *App*. Want me to watch it by screen recording instead?" → Yes calls `observer:setCapture` with `vision`; also Not now / Never;
  - [ ] curiosity questions.
- [ ] Ghost `not_watching` state on `blocked` events; badges for recording and vision mode.
- [ ] Hotkeys: off-the-record `Ctrl+Shift+O`, Record `Ctrl+Shift+R`, and "Ask the ghost" `Ctrl+Shift+Space` (Should).
- [ ] Optional: `MediaRecorder` video of the session.

**Phase 4 (5:30–7:45): Tutor and pointer → M3.**
- [ ] Tutor session with the Work Map and guide injected. On `tutor:violation`:
  - [ ] send the `[intervene]` nudge;
  - [ ] ghost `alert`, then fly to the field;
  - [ ] the panel replays the expert's step screenshots (`brain:stepsFor`).
- [ ] Client tools:
  - [ ] `point_at` → `brain:locate` → `displays:toDip` → ghost flies there and highlights it;
  - [ ] `replay_moment`;
  - [ ] `mark_step` → `tutor:mark_step`.
- [ ] Pointer self-test in Settings: the ghost flies to the Windows Start button. Check it at 100% and 150% scaling.
- [ ] Hide the ghost from screenshots (PLAN §12): try `setContentProtection(true)`; if it shows up as a black box, use the fallback in §5.10.

**Phase 5 (7:45–10:00):** smoothing the timing, then voice and ghost polish for the demo.

---

## 9. Agent C: Brain, Dashboard and Stage

**Mission:** be the app's brain and memory. It turns events into guides, Work Maps and App Profiles, catches mistakes, and builds every dashboard page and the demo stage.

**Owns:**
- `app/src/main/services/{llm,store,steps,memory,rollup,workmap,checker,mastery,describe,locate}.ts`;
- `app/prompts/**`;
- `app/src/renderer/dashboard/**`;
- `sandbox-erp/**` and `fixtures/**`.

**Phase 1 (0:00–0:45): fixtures and stage.**
- [ ] `fixtures/expert-session.jsonl`: a realistic 3-invoice expert session (context, click, commit, key, activity, shot events) following `shared/contracts.ts`. Also `fixtures/newhire-session.jsonl` with the €7,200 opex mistake, and `fixtures/ambient-day.jsonl` covering 3 apps.
- [ ] `sandbox-erp/`: MiniERP from PLAN §8. Labelled fields, Post → confirm dialog, expert and new-hire invoice sets, an IBAN and card number in one notes field. A web coding tool is fine here.
- [ ] `llm.ts`: Anthropic SDK wrapper with `fast()` and `smart()`, JSON output validated with zod, and image input.
- [ ] `store.ts`: paths under `%APPDATA%/apprentice` and JSON read/write helpers.

**Phase 2 (0:45–3:00): steps and questions → M1.**
- [ ] `steps.ts`: merge rules from PLAN §5.3 → `Guide`. Emit `guide:updated` live during a session.
- [ ] `describe.ts`: step screenshot → `screen_moment` and the name of an unnamed element. For `ephemeral` shots, describe, append the text to the app's memory log, then delete the file.
- [ ] `brain:pickQuestion` handler with `prompts/question_picker.md` (favours changed defaults, held or rerouted records, reasons not visible on screen; ≥1 guardrail).
- [ ] Dashboard: guide editor (edit, delete, merge, move up/down, insert note, blur a region on a canvas and save the image, hide a screenshot) and PDF export (`webContents.printToPDF`).

**Phase 3 (3:00–5:30): Work Map, memory, profiles → M2.**
- [ ] `workmap.ts`: on `session:stopped`, merge events, guide, transcript and answers → draft `WorkMap` plus `open_questions` (`smart()`). Apply `agent:correction`. Finalize on `agent:teachback_confirmed`. Handle the `brain:workmap`, `brain:guide` and `brain:stepsFor` requests.
- [ ] `memory.ts`: per-app daily JSONL from `text` events and shot descriptions, raw retention, delete per app / per day / everything.
- [ ] `rollup.ts`: App Profile updates (PLAN §5.2 triggers) → `profile:updated`.
- [ ] Dashboard pages:
  - [ ] Work Map timeline (steps → guide screenshots, quotes, guardrail chips);
  - [ ] App Profiles;
  - [ ] Memory (browse and delete);
  - [ ] Privacy (edit `PrivacyConfig`, block lists, the per-app capture mode from `app_modes.json`, then send `reload_config`).

**Phase 4 (5:30–7:45): tutor brain → M3.**
- [ ] `checker.ts`: on every `commit` (and vision-mode events) during a tutor session, check the guardrails → `tutor:violation`.
- [ ] `locate.ts`: `brain:locate` matches the target against `observer:tree`. If nothing matches, use vision on `observer:shot` and map coordinates back with `ShotMeta`.
- [ ] `mastery.ts`: per-step outcomes from `tutor:mark_step` and violations → report. Add the Mastery page.
- [ ] Curiosity: pick a question from App Profiles at a natural pause, within the caps (PLAN §5.2), → `popup:show` (kind `curiosity`). Save the answer into the profile.
- [ ] Guide buttons: **Polish** and **Add the why**. Markdown and HTML export.

**Phase 5 (7:45–10:00):** pitch deck (with a moonshot slide), demo script cues, and a backup video recorded with the humans.

---

## 10. Commands

```bash
# app (Agent B sets these up)
cd app && npm install && npm run dev        # Electron in dev mode
OBSERVER_FAKE=../fixtures/expert-session.jsonl npm run dev      # bash
$env:OBSERVER_FAKE="..\fixtures\expert-session.jsonl"; npm run dev   # PowerShell
# replays keep the fixture's timing; OBSERVER_FAKE_SPEED=4 plays 4x faster, OBSERVER_FAKE_MAX_GAP=3 caps pauses at 3 s

# sidecar (Agent A)
cd sidecar
python -m pip install -r requirements.txt
python spike.py                             # Phase 1: guided 2-minute capability check (Windows)
python observer.py --print                  # stream events to the terminal (Windows)
python observer.py --print --mode session   # ...including click screenshots
python observer.py --fake --print           # built-in demo scene (any OS)
python observer.py --redact-only            # masking only, no screen access (Electron starts it in fake mode)
python -m pytest tests                      # all observer tests (any OS)

# MiniERP (sandbox-erp/) is not used for now: the apprentice is tested on real apps.

# web recorder (static, no build; screen sharing needs localhost or https). Deploy: see web/README.md
cd web && python -m http.server 5173        # then open http://localhost:5173 in Chrome or Edge
sh scripts/make-download.sh                 # rebuild web/downloads/Protege-Windows.zip (PowerShell: scripts\make-download.ps1)

# demo film (video/, see video/README.md): frames from an HTML/Three.js scene, audio from ElevenLabs
cd video && npm install && node render.mjs && node audio.mjs && node mix.mjs   # -> video/out/protege-demo.mp4
node audio.mjs --local                      # offline score and sound effects (no voices) when ElevenLabs is unreachable
node render.mjs --film walkthrough --fps 15 && node audio.mjs --film walkthrough && node mix.mjs --film walkthrough   # 59 s technical walkthrough

# brain, dashboard and service tests (no API key needed; models are stubbed)
cd fixtures && npm install && npm run typecheck && npm test
cd app && npm run typecheck && npm run build
```

Keep these commands working. If you change how something runs, update this section in your next merge (that's the only AGENT.md edit agents may make without asking).
