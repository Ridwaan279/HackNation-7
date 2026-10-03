# AI Apprentice — 10-Hour Build Plan

Hack-Nation × ElevenLabs, Challenge 01 ("The AI Apprentice").
A Windows desktop companion that learns how an expert works, turns it into a Work Map,
and coaches new hires on their own screen. It takes Goldfish's always-on, local-first desktop
idea and Clicky's voice-and-pointer overlay, and points both at onboarding and knowledge retention.

---

## 1. Verdict

**Feasible if you narrow the scope. Not feasible as first described.**

| Idea as pitched | 10-hour reality | Decision |
|---|---|---|
| Desktop app (not web) | Fine if it's **Electron**: it's Chromium, so the ElevenLabs JS SDK, `getUserMedia`, `MediaRecorder` all work unchanged | **Build** |
| Windows Accessibility (UIA) signals | One Python sidecar gets the active app, focused field name/value and element rectangles | **Build, but timebox the spike to 45 min** |
| Voice agent that asks at natural pauses | Main judging criterion. Doable with ElevenAgents + input-idle signals | **Build first** |
| Click "record", screen-record + capture | `desktopCapturer` + `MediaRecorder` + a frame every 1.5–2 s | **Build** |
| Debrief, then Work Map with guardrails and quotes | One LLM pipeline + one debrief agent + one React timeline | **Build** |
| Tutor for new hire, Clicky-style pointing | Tutor + guardrail checker + overlay pointer | **Build** (pointer is a "should") |
| "New app opened → want to teach me this?" | Active-window watcher + popup + one spoken line | **Build late, small**: it's the moonshot teaser |
| Runs 24/7, learns each app over days/weeks | You can't show weeks of learning in a 3-min demo, and it's a privacy minefield | **Cut → moonshot slide** (the brief itself lists "the always-on apprentice" as a moonshot) |
| Logging what the user types, always | That's a keylogger. Fails Apprentice Test Q5 (Trust) | **Cut**: record input *timing*, not keystrokes; read field values only during a session |
| Local database | SQLite native modules are painful in Electron on Windows | **Use JSON files** in `%APPDATA%` |
| New employee installs it on their own machine | Sync isn't needed for the demo | **Mode switch on one laptop** + Work Map export/import JSON |

The judges score the **three modules** and the **five Apprentice Test questions** on **one
workflow**. Everything below is ordered by that.

---

## 2. What the judges check (from the brief)

- **Capture:** in a real task, at least 3 questions, each at a natural pause and about something on screen. At least 1 is about a guardrail.
- **Map:** the debrief asks at least 3 questions that weren't answered live, then ends with a teach-back the expert confirms. Every step and guardrail links to a screen moment and the expert's own words.
- **Teach:** a judge playing the new hire processes a case the expert never showed. The tutor catches at least 1 wrong decision **before it is saved** and explains it in the expert's reasoning.
- **Apprentice Test:** your demo must answer when to ask, what to ask, when it has understood, whether the new hire learned, and trust.
- **Pitch:** end on one moonshot slide that shows the path from today's MVP.

---

## 3. Architecture

```
┌──────────────────────────── Electron app (Windows) ────────────────────────────┐
│ MAIN PROCESS (Node)                                                              │
│  activeWindow.ts  get-windows npm, poll 1s → app/title change events             │
│  idle.ts          powerMonitor.getSystemIdleTime() → typing/idle signal          │
│  uia.ts           spawns sidecar/uia_watch.py, reads JSON lines from stdout      │
│  llm.ts           Anthropic SDK (keys stay in main, never in renderer)           │
│  gate.ts          "is now a natural pause?" + question budget                     │
│  store.ts         %APPDATA%/apprentice/sessions/<id>/…  (JSON + jpg + webm)      │
│  hotkeys          globalShortcut: start/stop, OFF-THE-RECORD                     │
│                                                                                  │
│ WINDOWS (React renderers)                                                        │
│  Companion   small, floating, always-on-top: mascot, state, Record button        │
│  Overlay     fullscreen, transparent, click-through: pointer + highlight box     │
│  Dashboard   sessions, Work Map timeline, mode switch (Expert / New hire)        │
│                                                                                  │
│ Companion renderer also runs:                                                    │
│  @elevenlabs/react useConversation  (interviewer / debrief / tutor agent)        │
│  screen capture: desktopCapturer → getUserMedia → MediaRecorder (video.webm)     │
│                  + canvas grab every 1.5–2 s → downscale → diff → main → vision  │
└──────────────────────────────────────────────────────────────────────────────────┘
          │ frames (only when changed)            │ voice (WebRTC)
          ▼                                       ▼
   Claude vision (fast model)              ElevenAgents (LLM of choice, Expressive Mode)
   → structured screen events              client tools ↔ app
```

**Sidecar (`sidecar/uia_watch.py`):** Python with the `uiautomation` package. Every 300–500 ms it
emits the focused element as one JSON line:
`{t, process, window_title, control_type, name, value, is_password, rect:[l,t,r,b]}`.
- If `is_password` is true, never emit `value`.
- Emit a `value_changed` event when the same control's value changes. This gives you
  "cost center changed 4711 → 0400" exactly, without vision.
- On request, dump the foreground window's controls (name, type, rect) for the pointer feature.

**Why hybrid (UIA + vision):** UIA gives exact field names and values cheaply. Vision covers apps
with poor accessibility trees and gives the "what is this screen" understanding the brief asks for.
If the UIA spike fails, ship vision-only plus window titles. Nothing else depends on UIA.

**Models**
- Screen events, guardrail checker, question picker (latency-sensitive): `claude-haiku-4-5-20251001`
- Work Map synthesis, debrief gaps, mastery report (quality-sensitive): `claude-opus-5-5` or `claude-sonnet-5-5`
- Agent brain inside ElevenAgents: a fast model from their LLM list. Latency matters more than IQ here.

---

## 4. The three flows

### 4.1 Capture (expert)

1. Expert picks a **role** at first launch (for example, "Accounts payable clerk"). It becomes `{{role}}` in
   every prompt. (Cheap version of your role idea. It can also be seeded from O*NET tasks for that role.)
2. Expert hits **Record** (or accepts the "want to teach me this app?" popup).
3. The app starts the ElevenLabs **Interviewer** agent, `MediaRecorder` and the frame loop.
4. **Event pipeline:** UIA `value_changed`/focus events plus vision diffs go into `events.jsonl`:
   `{t, source:"uia"|"vision", app, kind:"opened"|"field_changed"|"action"|"screen", summary, data, frame}`
   Push each meaningful event into the agent with `sendContextualUpdate("03:12 invoice 4471: cost center 4711→0400")`.
5. **When to ask** (Apprentice Q1). In `gate.ts`, a pause is a natural pause only if **all** hold:
   - an *action boundary* just happened (field committed, record changed, action button pressed),
   - keyboard/mouse idle ≥ 3 s (`powerMonitor`), or ≥ 8 s right after a new screen opened (they're reading),
   - nobody is speaking (track the agent's `onModeChange` and user VAD/transcript events),
   - question budget allows: ≤ 1 question per ~90 s, 3–5 per 10 min ("ask less, later").
   While the user is typing or clicking, call `sendUserActivity()` (throttled ~500 ms). It tells the agent not to take its turn.
6. **What to ask** (Apprentice Q2). The question picker (Haiku) gets the last N events, `{{role}}`, already-asked questions
   and answers, and returns `{question, type:"reason"|"guardrail"|"exception", ask_now|defer}`.
   It scores high when a value was *changed away from a default*, a record was held or rerouted, or the reason isn't on screen.
   It scores low when the screen already answers it. Force at least 1 guardrail question.
7. **Make the agent speak:** at a natural pause, send
   `sendUserMessage("[pause] Ask ONE short question: <question>. Refer to what's on screen.")`.
   Tag these as system nudges in `transcript.jsonl` so they're filtered from the Work Map.
8. The agent calls the client tool `record_answer({question, answer_quote, type, related_event_t})` when the expert answers.
   This gives you clean quotes with timestamps.

### 4.2 Map (debrief → Work Map)

1. On Stop, `llm.ts` merges events, transcript, answers and the keyframe index into a **draft Work Map** plus a
   list of `open_questions` (exceptions seen, rules it's unsure of, cases not seen). Use a strict JSON schema (§6).
2. Start the **Debrief** agent with the open questions and a draft summary injected (dynamic variables or an
   initial `sendContextualUpdate`). Prompt: ask the open questions one at a time (at least 3), then explain the whole
   process back in under 60 s, then ask "Is that how it works?"
3. Client tools: `record_answer`, `record_correction({step_id, correction_quote})`, `teachback_confirmed()`.
   **When it has understood** (Apprentice Q3): the debrief ends only when `open_questions` is empty (or every remaining
   one is marked "out of scope" by the expert) **and** `teachback_confirmed` fires.
4. Final merge produces `workmap.json`, status `confirmed`.
5. **Work Map UI** is a clickable timeline. Each step shows a thumbnail (click to seek `video.webm` to `t_start`),
   the decision, the reason as a quote with timestamp, and guardrails as chips (limit / exception / stop-and-ask), each with its quote.

### 4.3 Teach (new hire)

1. Switch the mode to **New hire**. Load a Work Map. Start the **Tutor** agent with the Work Map injected
   (contextual update at start; if too long, upload it to the agent knowledge base, as the brief suggests).
2. The same capture pipeline runs on the new hire's screen. No recording needed, just events.
3. **Guardrail checker** (Haiku) runs on every `value_changed`/action event. Input: the Work Map guardrails plus the current
   case state. Output: `{violation, step_id, guardrail_id, why}`. On a violation:
   - `sendUserMessage("[intervene] About to break G2 on step 4. Say 'Sabine would stop here. Why do you think?' then explain using her quote.")`
   - The overlay highlights the field (UIA rect) and the mascot flies to it (Clicky-style).
   - The companion shows a mini player replaying the expert's clip from that step's `t_start`.
4. At each step boundary, the tutor sometimes asks the new hire to **predict the next decision** before doing it.
5. "Where do I…?" questions: the agent calls client tool `point_at({target})`. Main dumps UIA controls of the foreground
   window, matches by name (LLM or fuzzy), and the overlay points at it. Fallback: send a screenshot to Claude and ask for coordinates.
6. **Whether the new hire learned** (Apprentice Q4): at the end, a mastery report (LLM over the teach session) lists, per step,
   done unassisted / done after a hint / guardrail caught, plus what to practice next.

**"Before it is saved" trick:** the checker fires on the *field change* (UIA value change), not on Save. Make the
sandbox app's **Post** a two-step action (Post → confirm dialog), like real ERPs "park" before "post". That gives the
tutor a guaranteed beat to step in.

---

## 5. Trust (Apprentice Q5): cheap and visible

- **Off-the-record hotkey** (`Ctrl+Shift+O`) and a button. It pauses frames, recording and UIA, mutes the agent's mic, and marks the
  gap in the timeline as "off the record". The agent says "Okay, I'm not recording."
- **Never read password fields** (`IsPassword` from UIA).
- **App allow-list**: capture runs only for apps the expert approved (the "teach me this app?" consent).
- **Redaction before anything leaves the machine**: regex for IBAN, email, phone, card numbers on event text and transcripts.
  Presidio is the stretch version; it's heavy (spaCy models), so add it only if time allows.
- **Local-first storage**: everything stays in `%APPDATA%`. Be honest in the pitch that frames go to a cloud vision model and audio
  to ElevenLabs. Mention zero-retention options and on-device models as the roadmap.

---

## 6. Data contracts (build against these)

```jsonc
// workmap.json
{
  "id": "ap-invoices-v1", "role": "Accounts payable clerk", "expert": "Sabine",
  "status": "draft|confirmed", "video": "video.webm",
  "steps": [{
    "id": "s4", "index": 4, "title": "Code the invoice to a cost center",
    "t_start": 192, "t_end": 201, "frame": "frames/000192.jpg",
    "screen_moment": "Invoice 4471, cost center field",
    "decision": "Re-coded from opex (4711) to capex (0400)",
    "reason": { "quote": "Equipment over €5,000 is always capex.", "t": 195, "source": "live|debrief" },
    "guardrails": [
      { "id": "g2", "type": "limit|exception|stop_and_ask",
        "rule": "No asset number, no capex booking",
        "quote": "…", "t": 197, "source": "live|debrief" }
    ],
    "judgment_call": true
  }],
  "open_questions": [],
  "teachback": { "confirmed": true, "t": 640, "corrections": [] }
}
```

```jsonc
// events.jsonl (one per line)
{"t":192.4,"source":"uia","app":"msedge","kind":"field_changed",
 "summary":"Invoice 4471: cost center 4711 → 0400","data":{"field":"Cost center","from":"4711","to":"0400"},"frame":"frames/000192.jpg"}
```

**ElevenLabs client tools** (register the same names in the agent dashboard):

| Tool | Agent | Does |
|---|---|---|
| `record_answer(question, answer_quote, type, related_event_t)` | Interviewer, Debrief | Saves an expert quote with its timestamp |
| `record_correction(step_id, correction_quote)` | Debrief | Patches the draft map |
| `teachback_confirmed()` | Debrief | Ends the debrief, triggers the final merge |
| `point_at(target)` | Tutor | Overlay points at a UI element |
| `replay_moment(step_id)` | Tutor | Plays the expert's clip |
| `mark_step(step_id, outcome)` | Tutor | Feeds the mastery report |

**Agent setup (ElevenLabs dashboard):** three agents (Interviewer, Debrief, Tutor) are simpler than one agent with overrides.
On each:
- Enable the **`skip_turn` system tool**, and prompt: *"While the expert is narrating their work, call skip_turn unless they ask you something directly."*
- Turn on Expressive Mode.
- Use `{{role}}` and other dynamic variables.

---

## 7. Sandbox app (build this, don't skip it)

Make **MiniERP**, a single local web page opened in Edge. It's your demo stage, and it makes every module reliable.
- An invoice list and an invoice form with supplier, amount, description, cost center, asset number and notes.
  Actions: Hold, Send for approval, Post (Post → confirm dialog).
- Use proper `<label>`/`aria-label` on every field so UIA reads clean names.
- **Expert set:** an equipment invoice for €6,400 (opex → capex, needs an asset number), a December invoice from the
  supplier that double-bills (hold), and an invoice from the Czech subsidiary (second approval).
- **New-hire set (never shown to the expert):** a €7,200 equipment invoice, plus one routine one.
- A web coding tool (v0/Lovable/Bolt) can produce this in about 30 minutes. It can also produce the Work Map timeline UI.
  Those tools can't do the Electron main process or native parts. That's Claude Code's job.

---

## 8. Repo layout

```
apprentice/                 electron-vite (React + TS)
  electron/main.ts, preload.ts
  electron/services/        activeWindow.ts idle.ts uia.ts llm.ts gate.ts store.ts
  src/windows/              Companion.tsx Overlay.tsx Dashboard.tsx
  src/agents/               interviewer.ts debrief.ts tutor.ts (client tools)
  src/workmap/              Timeline.tsx StepCard.tsx
  prompts/                  vision.md question_picker.md workmap_merge.md guardrail_check.md mastery.md
sidecar/uia_watch.py        + requirements.txt (uiautomation)
sandbox-erp/                static MiniERP
docs/PLAN.md                this file
```

---

## 9. Timeline (10 h, feature freeze at H8)

| Hours | Goal | Exit check (go / no-go) |
|---|---|---|
| **0:00–1:00** | Scaffold electron-vite. Create the 3 ElevenLabs agents. Talk to the Interviewer from the Electron window. Get one desktopCapturer frame. **UIA spike** against Edge + MiniERP. Start MiniERP in a web tool in parallel. | Voice works in Electron. A frame arrives. UIA reads "Cost center = 4711" **or** you drop UIA (vision + window title only). |
| **1:00–3:30** | Capture: frame loop + diff + vision events, UIA events, idle gate, question picker, nudge-to-speak, `record_answer`, MediaRecorder, session store. | **The agent stays quiet during typing and narration and asks 3 questions (1 guardrail) at pauses.** If not, stop everything else until it does. |
| **3:30–5:30** | Map: merge pipeline, draft map + open questions, Debrief agent, teach-back confirm, Work Map timeline UI with seek-to-moment. | A confirmed `workmap.json` renders, and every step and guardrail has a quote and a timestamp. |
| **5:30–8:00** | Teach: Tutor agent with the map, guardrail checker, intervention + replay clip, overlay highlight/pointer, mastery report. | The €7,200 opex mistake is caught before Post, in Sabine's words. |
| **8:00–8:45** | Trust: off-the-record hotkey, password skip, regex redaction. Teaser: "new app → teach me?" popup. | Visible in the demo. |
| **8:45–10:00** | Rehearse the full demo 3×. Record a **backup video**. Pitch deck + moonshot slide. | Clean run start to finish. |

**Team split (3–4 people):**
- **A:** Electron shell, capture, UIA sidecar, overlay.
- **B:** ElevenLabs agents, prompts, client tools, timing gate.
- **C:** LLM pipelines (events, picker, Work Map, checker) + Work Map UI.
- **D:** MiniERP, demo script, pitch, trust features.

**Solo or pair:** cut UIA and the pointer. Ship vision-only, and replace the overlay with a highlight in the companion window.

---

## 10. Risks to test early

1. **The agent talks over narration.** ElevenAgents replies to every user utterance by default. Use `skip_turn` + prompt. Test in hour 1.
   Fallback: mute the agent's mic outside question windows and transcribe narration separately with Scribe v2 Realtime.
2. **Making the agent speak on cue.** There's no "speak now" call. The `sendUserMessage("[pause] …")` nudge is the reliable pattern.
   Alternative: set the agent's turn timeout ("take turn after silence", 1–30 s) to about 5 s and rely on `sendUserActivity()` to hold it
   back while the user works. It's more native, but you get less control over *what* it asks.
3. **Native Node modules on Windows** (better-sqlite3, uiohook-napi) cost hours in electron-rebuild. Avoid them: use JSON files,
   `powerMonitor` and the Python sidecar.
4. **DPI scaling.** UIA rects are physical pixels, Electron windows use DIP. Convert with `screen.screenToDipPoint()`, or the pointer
   lands in the wrong place on 125%/150% displays.
5. **Chrome/Edge accessibility tree.** Usually it turns on when a UIA client queries it, but verify in the spike.
6. **Vision latency and cost.** Only send frames that changed (pixel diff), downscale to about 1280 px, use Haiku. Rely on UIA for field values.
7. **Overrides/dynamic variables.** Prompt and first-message overrides must be enabled in each agent's security settings, or startSession silently ignores them.
8. **API keys.** Keep them in the main process (`.env`). For the agent, a public agent ID is fine for the hackathon; a signed URL from main is better.
9. **Dev environment.** Build and test on the Windows laptops (run Claude Code locally there). A Linux/cloud session can scaffold code but can't run UIA, desktopCapturer on Windows, or the overlay.

---

## 11. Cheap stretch goals (in order)

1. **Any language.** The expert speaks German and the tutor teaches in English. Set the agent language, and the Work Map is generated in English anyway. Almost free.
2. **Agent-ready guardrails.** Export the Work Map as markdown/JSON instructions an agent can load. One template plus one LLM call. Feeds the moonshot.
3. **Role seeding from O*NET.** Preload typical tasks for the chosen role into the question picker.
4. **Two experts, one task.** Diff two Work Maps and ask each why. Skip unless everything else is done.

---

## 12. Demo script (about 3 min)

1. **Hook (15 s):** Sabine, 24 years, retiring in 18 months.
2. **Capture (60 s):** the expert processes 3 MiniERP invoices while talking. The companion shows "listening / waiting for a pause".
   The agent asks: "You moved that one to capex. What made you do that?" Then a guardrail question: "Is there an amount where you'd stop and ask someone?"
3. **Map (40 s):** the debrief asks 3 gap questions. Teach-back. The expert corrects one detail. The Work Map appears (about 7 steps, 3 judgment calls, 4 guardrails), and you click a step to jump to its screen moment.
4. **Teach (50 s):** the new hire opens the €7,200 equipment invoice and types the opex code. The mascot flies to the field: "Sabine would stop here. Why do you think?" Her clip replays, the new hire fixes it, and the mastery report shows.
5. **Trust (10 s):** hit off-the-record, and show that the password field is never read.
6. **Moonshot (15 s):** the always-on apprentice. Show the "new app detected, want to teach me?" popup as the seed. Next comes a living company memory that only asks about what's new, and then agents that follow the same guardrails.
