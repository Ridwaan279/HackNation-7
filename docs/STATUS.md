# AI Apprentice: where things stand

Updated 2026-10-04, after the three agent branches were merged into `main` and the remaining parts were built by one agent. The spec is `docs/PLAN.md`; the old per-agent notes in `docs/agents/` are history.

## Run it

```powershell
cd sidecar; python -m pip install -r requirements.txt     # once
cd ..\app; npm install; npm run dev                        # the app with the real observer (Windows)
$env:OBSERVER_FAKE="..\fixtures\expert-session.jsonl"; npm run dev   # replay a recorded session instead
cd ..\sandbox-erp; npm run dev                             # MiniERP at http://127.0.0.1:4173 (open it in Edge)
```

`app/.env` needs `ANTHROPIC_API_KEY`, `MODEL_FAST`, `MODEL_SMART`, `ELEVENLABS_API_KEY` and the three `VITE_AGENT_*` ids (see `app/.env.example`). Without the Anthropic key every model step falls back to a local version (below), so the app still runs end to end, just less cleverly.

## What is built

| Module | What it does | Where |
|---|---|---|
| **Observer** | Clicks, field commits, context, ambient text, screenshots with blurring, privacy gate, masking, DPI and app scaling, accessibility health, vision mode | `sidecar/`, `app/src/main/services/observer.ts`, `displays.ts` |
| **Capture** | Live step guide from clicks and commits, questions at natural pauses (≥1 guardrail), answers linked to steps | `steps.ts`, `gate.ts`, `describe.ts`, `session.ts` |
| **Guide editor** | Edit, delete, merge, reorder, notes, blur, hide screenshot; **Polish**, **Add the why**; export PDF, HTML, Markdown + images | `steps.ts`, `dashboard/GuidesPage.tsx` |
| **Map** | Draft Work Map on Stop (reasons and guardrails must be the expert's own words), debrief answers close open questions, corrections, teach-back confirms | `workmap.ts`, `dashboard/WorkMapsPage.tsx` |
| **Teach** | Guardrail checker on every commit and on Post / Save / Submit / Confirm clicks, using the form's current values; the ghost flies to the field; the expert's screenshots replay; `point_at` finds controls (vision fallback); mastery report | `checker.ts`, `locate.ts`, `mastery.ts`, `session.ts`, `dashboard/LessonsPage.tsx` |
| **Always on** | Per-app daily memory (masked), active minutes, App Profiles (after 10 active minutes, 20 KB of new log, or Refresh), curiosity questions (1 per hour per app, 3 per day) answered on the App Profiles page | `memory.ts`, `rollup.ts`, `curiosity.ts`, `dashboard/ProfilesPage.tsx`, `MemoryPage.tsx` |
| **Trust** | Masking toggles, default skips, block lists, allow-only, local-only apps, retention, capture mode per app, pause 15 min / 1 h / until tomorrow, off the record (Ctrl+Shift+O), delete per day / app / everything | `privacy.ts`, `dashboard/PrivacyPage.tsx`, `memory.ts` |
| **Shell, voice, ghost** | Overlay ghost with states and pointer, panel, pop-ups (teach this app, a11y blind, warnings, curiosity), ElevenLabs Interviewer / Debrief / Tutor with client tools, hotkeys | `app/src/main/services/{windows,session,gate,tts,hotkeys,popups}.ts`, `app/src/renderer/{overlay,panel,mascot,agents}` |
| **First run** | Role and expert name (used as `{{role}}` and in Work Maps); welcome panel on the dashboard | `settings.ts`, `dashboard/index.tsx` |

**Without a model:** the Work Map is drafted from the guide and the expert's answers; corrections become the step's reason; the guardrail checker uses a local rule (the value the expert corrected away from, plus the step's topic on screen and any amount threshold); App Profiles are built from the log itself; Polish removes repeated switches and empty-page clicks; the mastery summary is counted; question picking already had a local fallback.

## Checked

- `cd sidecar; python -m pytest tests`: 228 tests.
- `cd fixtures; npm test`: 36 tests (capture, guide tools, Work Map flow, memory, profiles, curiosity caps, checker incl. the €7,200 demo case, locate, mastery, privacy). Models are stubbed; no API calls.
- `cd sandbox-erp; npm test`: 3 tests.
- `cd app; npm run typecheck; npm run build`: pass.
- Dashboard pages rendered in headless Chromium with sample data: no console errors.
- On Windows (one laptop, 150%): the Phase 1 spike passes 19/19; `observer.py --print --mode session` captured clicks, commits, masked text and blurred screenshots correctly.

## Not yet checked on Windows

- The whole Electron app with the real observer: the M1–M3 smoke tests in `AGENT.md` §5 (questions at pauses, debrief → confirmed Work Map, the tutor catching the €7,200 opex mistake before Post, mastery report).
- Live ElevenLabs conversations and live Anthropic calls (all model paths are tested with stubs).
- Pointer accuracy at 100% scaling (150% was checked by B).

## Not built

- "Ask the ghost" (Ctrl+Shift+Space only opens the panel), the pointer self-test (ghost flies to the Start button), `MediaRecorder` video replay.
- Polish only cleans titles and drops noise; it does not group steps into sections.
- Production packaging: `app/prompts/*.md` must be copied to `resources/prompts` (dev mode reads them from `app/prompts`).
- Stretch goals (PLAN §13): agent-ready export / MCP server, ask your history, two experts.

## Demo smoke test (Windows)

1. `npm run dev` in `app/`, MiniERP open in Edge. Complete the welcome (role, expert).
2. **Capture:** Record in the panel, process the three expert invoices while talking. Steps with screenshots appear live; the agent asks at pauses, at least one guardrail question.
3. **Map:** Stop → the draft Work Map appears (Work Maps tab), the debrief asks the open questions, correct one detail, confirm the teach-back → status Confirmed. Blur a region and export a PDF on the Guides tab.
4. **Teach:** on the Work Maps tab, Start a lesson. In MiniERP set **Invoice set** to **New-hire lesson**, open INV-5801 (€7,200 equipment), leave cost center 6100, click Post → the ghost flies to Cost center and the tutor intervenes; the expert's screenshots replay. Fix it, stop the lesson → the Lessons tab opens with the report.
5. **Trust:** the masked card number and IBAN in a step; Ctrl+Shift+O; Privacy → Delete everything.
6. **Always on:** App Profiles for apps used today; a curiosity question pops up at a pause.
