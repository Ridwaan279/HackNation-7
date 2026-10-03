# Agent A status: Observer

Branch: `agent/a-observer`. The code for all of Phase 1–4 is written. Everything that can run on Linux is tested. **The Windows-only parts have not run on Windows yet.** Run `python spike.py` first (see "Verify on Windows").

## Done

**Sidecar** (`sidecar/`). Run `python observer.py --print` on Windows, or `python observer.py --fake --print` anywhere.

| Area | What works | Where |
|---|---|---|
| Protocol | JSON lines on stdout (ASCII-only), commands on stdin, replies echo the `id`. stdout is isolated, so library prints can't corrupt it | `observer.py`, `protocol.py` |
| Threads | Hook thread → queue → fast thread (clicks, keys, focus, context) and slow thread (text, health, screenshots, displays). Both are COM-initialised in MTA | `observer.py` |
| Privacy gate | Password managers, banking, private windows (title + toolbar badge), internal browser pages, system dialogs, our own windows, user block lists, allow-only, pause | `privacy.py`, `config/skiplists.json` |
| Masking | Cards (Luhn, keeps last 4), IBANs (mod-97, keeps last 4), SSNs, API keys, JWT, PEM, `key=value` secrets, high-entropy strings; email/phone optional | `redact.py` |
| Context | `context` / `blocked` at 2 Hz on change. Popups and dialogs belong to their owner window. A click on another window emits its `context` first. While the user types a search in the address bar, the page's last URL keeps the key stable (typing a bank's address still blocks at once) | `engine.py` |
| Browsers read the page only | Text snapshots, sensitive-field scans and `tree` read only the web page, never the browser's tab strip (other tabs' titles could be skipped sites). A click on a browser tab is reported as "browser tab". Electron apps may fall back to the whole window | `uia.py`, `engine.py` |
| Clicks | Element under the cursor, rect check, window-only screenshot (sessions) with a ring and a box, sensitive fields blurred | `engine.py`, `shots.py`, `uia.py` |
| Commits | Field value when focus leaves or Enter/Tab/Ctrl+S (`final: true`), or after 0.8 s idle (`final: false`). Never reads password-like fields | `commit.py` |
| Keys | `key` (Enter, Tab, Esc, Ctrl+S, Ctrl+Enter) and throttled `activity`. No characters, ever | `hooks.py` |
| Ambient text | Visible text → masked → only new lines (`text`). Caps: depth 10, 300 elements, 1.5 s, 4 KB; documents 1 KB | `textsnap.py` |
| Screenshots | Heartbeat every 5 s on change (sessions), ambient every 60 s (960 px wide, ephemeral), vision mode every 2 s / 30 s, on-demand `shot`. Before saving any screenshot, the sensitive-field map is refreshed if it's more than 3 s old | `engine.py`, `shots.py` |
| DPI and scaling | Per-monitor-v2 awareness set before anything else; `displays` events; per-window awareness and DPI in `context`; rect check → `app_scaling` corrected or untrusted, saved to `app_modes.json` and applied to every emitted rect | `display.py`, `scaling.py` |
| Accessibility health | ok / weak / blind per app (named elements, text, click resolution, Chromium empty document checked twice 2 s apart, remote-session processes). `prompt: true` at most once per app per 24 h | `health.py` |
| Commands | `redact`, `tree` (pointable elements, corrected rects, masked names), `mode`, `shot`, `set_capture`, `reload_config`, `a11y_ack` | `engine.py` |
| Hardening | Hook watchdog (`hook_restarted`). UIA timeouts 2 s / 3 s instead of up to 20 s. `uia_timeout` warning when an app hangs | `engine.py`, `uia.py` |
| Phase 1 spike | Guided 2-minute check of every OS capability; opens its own test page (`spike_page.html`) | `spike.py`, `spike_page.html` |

**Electron** (`app/src/main/services/`):
- `observer.ts`: spawns the sidecar, bridges every `observer:*` request, re-emits events as `observer:event`, and restarts after a crash (also when Python is missing) while keeping the mode. `OBSERVER_FAKE` replays a fixture.
- `displays.ts`: `displays:toDip` via `screen.screenToDipRect`, plus the debounced `display_mismatch` check.

## Verification so far (Linux)

- **194 Python tests** (`cd sidecar && pytest tests`), covering:
  - masking vectors and near-misses, the privacy gate, the protocol and config;
  - engine scenarios: password manager never read, a tab navigating to a bank blocked even on an immediate click, password fields never emitted, pause drops pending typing, a blind app prompts once then switches to vision mode, scaling correction saved and applied, heartbeats only on change, a first click in a new window already blurs masked fields;
  - adapters against fakes that mirror the real `uiautomation` 2.0.29 and `pynput` 1.8.2 APIs (checked against their source);
  - the real runner as a subprocess.
- **Electron files** type-check under `strict` (also without `esModuleInterop` and with `isolatedModules`). Node runtime tests drive the real Python sidecar through `ObserverClient`, including a crash/restart cycle, fixture replay, and `displays.ts` against a stubbed `screen`. That harness lives outside the repo, because `app/` has no test runner yet.

## Verify on Windows (do this first, about 5 minutes)

```powershell
cd sidecar
pip install -r requirements.txt
python spike.py                            # guided; paste the summary below
python observer.py --print --mode session  # click around MiniERP: context, click (with shot), commit, text
pytest tests                               # should also pass on Windows
```

Not yet run on Windows: `winapi.py`, the Windows branch of `display.py`, `uia.py` against real apps, `hooks.py` with real pynput, mss capture, and the UIA timeouts. If the spike shows web content empty, start Edge with `--force-renderer-accessibility`.

Spike results (one laptop, 2560x1600 at 150%, Edge):

- **Run 1:** the wrong window was in front (VS Code). The spike now waits for a browser window.
- **Run 2: 13/17 passed.** DPI, monitors, UIA timeouts (after the CUIAutomation8 swap), address-bar URL, private-window check, web content visible, window screenshot, click → element with correct rect at 150%, keyboard hook and Enter.
- **Run 2 failures and what was done:**
  - "Text snapshot" and "Pointable elements" visited only 2 elements: the first web Document found wasn't the page. Fixed by picking the largest visible Document; the spike now also prints every Document it sees.
  - "Password field" timed out because no password field was on screen, and the last check ran after Enter had navigated Google. The spike now opens its own test page (`spike_page.html`) and reads the field before Enter.
- **Run 3: 15/19 passed.**
  - Now passing: click → Button 'Post' with correct rect at 150%, focused password box detected and its value not read, the Cost center value read, Enter detected.
  - Still failing: walking *down* from the page's Document gave only 2 elements, while "element at point" and "focused element" reached the page fine. Most likely cause: Edge builds the page's accessibility tree lazily, and the spike read the text before anything had hit-tested the page.
  - Changes: the page Document is now found by hit-testing the middle of the window and walking *up* (which also wakes the tree). `FindAll` is used when tree-walking returns no children near the top of the page. A failing read now puts a diagnostic into the summary line.
- **Run 4:** _(paste here)_

## Stubbed / faked

- **Vision-mode value changes:** the sidecar only provides screenshots for vision-mode apps. Turning them into `commit` events (`source: "vision"`) is Agent C's `describe.ts` job, emitted on the bus as `observer:event`.
- **Fake mode:** `python observer.py --fake` has a built-in MiniERP demo scene. `OBSERVER_FAKE=<file>` in Electron replays Agent C's fixtures.

## Needs from others (integration notes)

**Agent B:**
- **Service loader:** load `observer.ts` and `displays.ts` like any service. `--data-dir` is `ctx.paths.root` and `--config-dir` is `ctx.paths.config`.
- **Python:** `APPRENTICE_PYTHON` overrides the Python executable, `APPRENTICE_SIDECAR` the script path. The defaults are `python` on Windows and `../sidecar/observer.py` from `app/`.
- **Off the record:** send `observer:mode` with `paused`, and remember the previous mode to restore it. The sidecar emits `blocked {reason: "paused"}` and discards un-committed typing.
- **Sessions:** `observer:mode` with `session`, `tutor` or `ambient`. Each mode change re-emits the current `context`.
- **A11y pop-up:** show it only when `a11y_health.prompt === true`, then answer with `observer:a11yAck` (`yes` / `later` / `never`). Send `later` if the bubble times out.
- **Ghost:**
  - `blocked` means not watching (`reason` says why);
  - `context.capture === "vision"` means the camera badge;
  - warnings to surface: `sidecar_restarted`, `hook_restarted`, `uia_timeout` ("app not responding"), `display_mismatch`, `dpi_unaware`.
- **Our own windows:** clicks on them are ignored by pid (Electron's pid is passed as `--parent-pid`). The ghost still shows up in screenshots unless `setContentProtection` works.
- **Pointing:** all rects are physical pixels, so convert them with `displays:toDip` before drawing.

**Agent C:**
- **Screenshot paths:** relative to `ctx.paths.root`. Kept shots are `shots/YYYY-MM-DD/<ms>.jpg`, ephemeral ones `shots/tmp/<ms>.jpg`. Delete ephemeral files after describing them; the sidecar removes leftovers after 10 minutes.
- **`ShotMeta`:** `screen_px = origin_px + image_px / scale`. `size_px` is the captured screen region in physical pixels. `auto_blur: false` means sensitive fields were *not* blurred (vision mode), so offer the manual blur.
- **Commits:** an idle commit (`final: false`) can be followed by more commits for the same field, so coalesce them. Values are masked and capped at 1000 characters. `masked: true` tells you a value was masked.
- **App keys:** always lowercase (`excel.exe`, `browser:minierp.local`).
- **`observer:shot`:** returns a `shots/tmp/` path and is not emitted as an event.
- **`observer:tree`:** returns `[]` when the window is blocked or in vision mode. Fall back to vision in that case.
- **Privacy page:** write `privacy.json` atomically (temp file + rename), then call `observer:reloadConfig`. To change an app's capture mode, prefer `observer:setCapture` over editing `app_modes.json`; the sidecar writes that file too.

## Known limits

- Chrome Incognito is detected through the toolbar badge's accessibility name. Edge's "InPrivate" and Firefox's "Private Browsing" also appear in titles. Confirm each browser with the spike.
- Text snapshots read at most 300 elements in 1.5 s, so very long pages are only partly read. Lines are capped at 300 characters, document text at 1 KB, and each `text` event at 4 KB. `tree` stops after 1.5 s or `max` elements.
- Elevated ("Run as administrator") windows and Citrix/RDP windows can't be read. Remote sessions are reported as blind, which prompts the switch to vision mode.
- GUIDs and hashes are masked as secrets (fail-safe).
- Owned popups that extend outside their window are included in the capture region (the union of both).

## Changes to the plan's file list

- `scaling.py` holds the pure rect-correction logic (it's testable). `display.py` keeps the Windows DPI and monitor calls.
- New files: `winapi.py`, `engine.py`, `commit.py`, `textsnap.py`, `model.py`, `config.py`, `backend_fake.py`, `backend_windows.py`.

## Contract changes (all additive, in their own `contracts:` commits)

- `ReadyEvent` (first line the sidecar prints).
- `CommitEvent.final`, `ShotMeta.auto_blur`, `A11yHealthEvent.prompt`.
- `rect_anchor` on `AppScalingEvent` and `AppModes`. The sidecar applies `rect_scale` itself; the comment now says so.
- `WarningEvent.code` gains `display_mismatch`.
- `a11y_ack` command with the `observer:a11yAck` request, and the `observer:reloadConfig` request.
