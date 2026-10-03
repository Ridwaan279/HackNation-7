# AI Apprentice: 10-Hour Build Plan (v2)

Hack-Nation × ElevenLabs, Challenge 01 ("The AI Apprentice").

The AI Apprentice is a Windows desktop companion. It learns how an expert works, turns that into step-by-step guides and a Work Map, and then coaches new hires on their own screen. It borrows from three kinds of products and aims all of them at onboarding and knowledge retention:

| From | We take | Where it lives here |
|---|---|---|
| **Goldfish** | It's always on and reads only text, through the accessibility layer. It keeps a local memory, masks secrets, skips sensitive apps by default, caps its nudges, and lets you browse and delete memory | Ambient mode, App Profiles, Privacy |
| **Scribe / Tango** (step-guide tools)¹ | A screenshot and a step on every click, turned into an editable guide | Step capture, Guide editor |
| **Clicky** | A voice companion that looks at your screen and points at the button to press | Tutor mode, overlay pointer |
| **Only us** | Asks *why* at natural pauses, runs a debrief with a teach-back, builds a Work Map with guardrails, and has a tutor that catches mistakes before they're saved | Capture, Map, Teach |

Pitch line: *Scribe records what you clicked. Goldfish remembers what you read. The Apprentice learns why.*

¹ This Scribe is scribehow.com, not ElevenLabs' Scribe speech-to-text. Say "step guides" on stage so nobody mixes them up.

---

## 1. Verdict

**Feasible with 3–4 people, but tight.** The three additions (step guides, the privacy layer and 24/7 per-app learning) all run on one observer pipeline: a Python sidecar that watches clicks and reads the Windows accessibility tree. If you build that once, first, the additions cost much less than they look.
- **Effort:** about 30 person-hours of building plus demo prep. That leaves no slack for a 4-person team, so one 2-hour detour costs you a "Should" item.
- **2 people:** ship the Must list only (§9).
- **Solo:** it doesn't fit.

**What changed since v1:** v1 cut the 24/7 learning. Goldfish's design makes it workable: text only, masked before saving, banking sites and password managers skipped, everything stored locally. It reuses the sidecar you need anyway, and it turns the brief's "always-on apprentice" moonshot into something you can actually show.

| Feature | How | Decision |
|---|---|---|
| Desktop app | Electron. Chromium is inside, so the ElevenLabs JS SDK, `getUserMedia` and `MediaRecorder` work unchanged | **Build** |
| 24/7 per-app learning | Text-only memory per app → periodic LLM summary → **App Profile** | **Build (text only)** |
| Reading what's typed | Read the field's final value through accessibility when the user leaves it, then mask it. No raw keystrokes, never password fields | **Build** |
| Click → screenshot → step guide | Click hook + clicked element from accessibility + screenshot of that window only → editable guide | **Build** |
| Security | Masking, default skips, block lists, off-the-record, watching indicator, delete-all | **Build** |
| Voice interviewer, debrief, Work Map, tutor | As in v1. These are what gets judged | **Build** |
| Clicky-style pointer | Accessibility rectangles, with vision as the fallback | Should |
| "New app → want to teach me?" | The first time an app gets 2+ minutes of use | Should |
| Goldfish's writing key, dictation, morning/evening briefs, MDM | Not judged, not about onboarding | Won't |
| Sync between machines | Export and import a file instead | Won't |

---

## 2. What gets judged, plus your must-haves

**From the brief:**
- **Capture:** in a real task, at least 3 questions, each at a natural pause and about something on screen. At least 1 must be about a guardrail.
- **Map:** the debrief asks at least 3 questions that weren't answered live, then ends with a teach-back the expert confirms. Every step and guardrail links to a screen moment and to the expert's own words.
- **Teach:** a judge playing the new hire processes a case the expert never showed. The tutor catches at least 1 wrong decision **before it is saved** and explains it using the expert's reasoning.
- **Apprentice Test:** the demo must answer five questions: when to ask, what to ask, when it has understood, whether the new hire learned, and trust.
- **Pitch:** end with one moonshot slide that shows the path from today's MVP.

**Your must-haves:**
- Editable step guides built from clicks and typing.
- Masking, default skips and block lists.
- 24/7 per-app learning with per-app summaries.
- Typed text is read, but private fields never are.

---

## 3. Three modes, one pipeline

| Mode | When it runs | What it captures | What leaves the machine |
|---|---|---|---|
| **Ambient** (24/7) | Always, unless the app is skipped, blocked or paused | **Text only:** app, window title, URL, newly visible text, final field values (masked), input timing | Masked text in periodic summary calls |
| **Teach session** (expert) | The expert presses Record, or says yes to "want to teach me this app?" | Everything ambient captures, plus a screenshot on every click (that window only, sensitive fields blurred), voice, and optional video | Screenshots go to the vision model, voice goes to ElevenLabs |
| **Tutor** (new hire) | The new hire starts a lesson | Same as a teach session, but no recording is kept | Same |

Rule to repeat on stage: **always-on is text only. Pixels only when you press Record.**

---

## 4. Architecture

```
┌──────────────────────────── Electron app (Windows) ────────────────────────────┐
│ MAIN (Node)                                                                      │
│  observer.ts  spawns the sidecar, reads its events, sends commands               │
│  gate.ts      natural-pause detection, question budget, nudge caps               │
│  steps.ts     click + commit events → guide steps                                │
│  memory.ts    per-app daily logs, retention, delete                              │
│  rollup.ts    per-app logs → LLM → App Profiles                                  │
│  llm.ts       Anthropic SDK (API keys stay in main, never in a renderer)         │
│  tts.ts       ElevenLabs text-to-speech one-liners ("Want to teach me Excel?")   │
│  store.ts     sessions, guides, Work Maps as JSON under %APPDATA%/apprentice     │
│ WINDOWS (React)                                                                  │
│  Companion  floating mascot, watching/not-watching indicator, Record, voice      │
│  Overlay    fullscreen, transparent, click-through: pointer + highlight box      │
│  Dashboard  Guides · Work Maps · App Profiles · Memory · Privacy · Lessons       │
└───────────────────────────────────────────┬──────────────────────────────────────┘
                                            │ JSON lines over stdin/stdout
┌───────────────────────────────────────────┴──────────── Python sidecar ─────────┐
│ hooks.py    pynput mouse + keyboard → queue (printable keys dropped at source)   │
│ uia.py      focus, value commits, element under the click, URL, text snapshots   │
│ privacy.py  skip lists, block lists, private-window check → "blocked" events     │
│ redact.py   masking rules + card and IBAN checks, applied before anything leaves │
│ shots.py    mss: screenshot of the foreground window, click highlight, blurring  │
└──────────────────────────────────────────────────────────────────────────────────┘
        screenshots (sessions only)                     voice (WebRTC)
             ▼                                               ▼
   Claude vision → step / screen descriptions      ElevenAgents: interviewer, debrief, tutor
```

**Why all the OS-level work lives in Python:** `uiautomation`, `pynput`, `mss` and `Pillow` install with pip and need no compiler. Python also ships `sqlite3` if you want a database later. That keeps native modules out of Electron, and native modules are where Windows hackathon teams lose hours.

**Sidecar rules (each one prevents a known Windows bug):**
- Make the process **per-monitor DPI-aware** before anything else (`SetProcessDpiAwareness(2)`). Otherwise click coordinates, screenshots and accessibility rectangles disagree on 125%/150% displays.
- Hook callbacks only push to a queue. Windows **silently removes** a low-level hook whose callback is slow.
- All accessibility calls run on a worker thread wrapped in `UIAutomationInitializerInThread()`.
- Order of operations: privacy gate → redaction → emit. Nothing raw is ever written to disk or sent anywhere.

**Models:** put them in `.env` as `MODEL_FAST` and `MODEL_SMART`.
- `MODEL_FAST` (Claude Haiku tier) handles anything that needs to be quick: step and screen descriptions, the question picker, the guardrail checker and the App Profile rollups.
- `MODEL_SMART` (Claude Opus or Sonnet tier) handles anything that needs quality: Work Map synthesis, debrief gaps, the guide's Polish button and the mastery report.
- The agents inside ElevenAgents should use a fast model from their LLM list, because latency matters more than intelligence there.

---

## 5. Flows

### 5.1 First run (about 2 minutes)
1. Pick a role. It becomes `{{role}}` in every prompt.
2. Review the privacy defaults: what's skipped, and add blocked apps or domains.
3. Mic check.
4. The mascot introduces itself.

On Windows, accessibility, hooks and screen capture need no permission prompts. Only the microphone does.

### 5.2 Ambient learning (24/7, text only)
1. **Check the context every 500 ms.** The sidecar reads the foreground app, the window title and the browser URL (from the address bar's accessibility element), and checks whether that context is skipped or blocked. If it is, the sidecar emits only `{"type":"blocked","reason":…}`, and the companion shows "Not watching: password manager".
2. **Snapshot visible text.** On every window change, and every 15 s while that window is active and changing, the sidecar reads the visible text from the accessibility tree.
   - Caps: depth 8, 300 elements, 1.5 s, 4 KB. For long documents, keep only the first 1 KB.
   - It masks the text and keeps only lines that are new since the last snapshot.
3. **Commits.** When the user leaves a field, its final value is logged as a commit, masked (§6.5).
4. **Storage.** Everything goes to `memory/<app>/<date>.jsonl`. The app key is the process name, or `browser:<domain>` for web apps.
5. **Rollup into an App Profile.**
   - **Trigger:** 10+ minutes of active use in an app, 20 KB of new text, or the Refresh button.
   - **Input:** the current App Profile plus the new masked log (cut to about 6k tokens, prioritizing window titles, commits and click targets) goes to `MODEL_FAST`.
   - **Output:** an updated profile (§7) covering what the app is used for, recurring tasks, screens and fields, patterns, exceptions seen, open questions, and a 3-line "today in this app".
6. **Curiosity (the always-on apprentice).** The apprentice can ask a profile's open questions while the user is in that app, at a natural pause.
   - Caps: 1 per hour per app, 3 per day.
   - The mascot first shows "Got a sec?" and only speaks if the user accepts.
   - Answers are saved into the profile as expert quotes, and they seed the next teach session.
7. **"Want to teach me this app?"** The first time an app gets 2+ minutes of use, the mascot offers a teach session, spoken through ElevenLabs TTS. The choices are Yes, Not now, and Never for this app (which adds it to the block list).

App Profiles also make the judged modules better. The interviewer already knows what's normal in an app, so it asks about what's unusual. The tutor can tell a new hire what each app is for.

### 5.3 Teach session: capture + step guide (expert)
1. The expert presses Record. That starts the Interviewer agent, step capture and, optionally, `MediaRecorder` video.
2. **On every mouse-down**, the worker thread:
   - finds the element under the cursor (name, control type, automation ID, rectangle);
   - takes a screenshot of the **foreground window only**;
   - draws a ring at the click point and a box around the element;
   - blurs password fields and any field whose value was masked;
   - saves the image.
3. **When the user leaves a field**, the sidecar emits a commit event with the field name and its old → new value, masked.
4. **`steps.ts` turns events into steps:**
   - A click in a text field followed by a commit becomes "Enter **0400** in **Cost center**".
   - A click on a Button, MenuItem, Hyperlink or TabItem becomes "Click **Post**". A ListItem becomes "Select…", a CheckBox becomes "Check…".
   - Two clicks on the same element within 1.5 s become one double-click.
   - A window switch becomes "Switch to **Excel**". Enter or Ctrl+S right after a commit attaches to that step.
   - If the element has no name, vision names it from the screenshot.
5. **Vision runs once per step, not as a video stream.** Each step's screenshot gets a short screen-moment description, such as "Invoice 4471, cost center field". A 5 s heartbeat that fires only when the screen changed catches reading and scrolling. That's fewer and sharper calls than a frame every 1–2 s, and the questions are still "about something visible on screen", as the brief requires.
6. **When to ask.** A pause counts as natural only if all of these hold:
   - an action just finished;
   - there's been no input for 3 s (8 s after a new screen opens, because they're probably reading);
   - nobody is speaking;
   - the question budget allows it: 1 per ~90 s, 3–5 per 10 min.

   While the user types or clicks (input timing comes from the sidecar), call `sendUserActivity()` to keep the agent quiet.
7. **What to ask.** The question picker (`MODEL_FAST`) favours values changed away from their defaults, records that were held or rerouted, and reasons the screen doesn't show. It must produce at least 1 guardrail question.
   - **Delivery:** the question goes to the agent as `sendUserMessage("[pause] Ask ONE short question: …")`.
   - **Context:** events reach the agent through `sendContextualUpdate`.
   - **Answers:** the agent saves them with `record_answer`, and calls `skip_turn` while the expert is narrating.
8. The guide builds live in the companion panel as steps arrive.

### 5.4 Step guide editor
- **Step cards:** number, editable title and note, screenshot with highlight, app badge, timestamp, and the expert's quote when one exists.
- **Edit:** rename, delete, merge with the previous step, move up or down, insert a note step, **blur a region** (drag a box), hide a screenshot.
- **AI buttons:** **Polish** (clean titles, group into sections, drop noise) and **Add the why** (pull in quotes and guardrails from the Work Map).
- **Export:** PDF via `webContents.printToPDF` (built into Electron), Markdown plus an images folder, or a single HTML file.
- **Quick guide:** Record Steps with the voice agent off. It's the same pipeline, for experts who just want a how-to.

### 5.5 Map: debrief → Work Map
**The guide is the "what"; the Work Map is the "why".** Each Work Map step groups several guide steps (`guide_steps`), so its screen moment is a real click screenshot. Its reasons and guardrails link to transcript quotes with timestamps. To replay a step, show its screenshots as a slideshow, or play the video from `t_start` if you recorded one.
1. When the expert presses Stop, `MODEL_SMART` merges events, guide steps, transcript and answers into a **draft Work Map**, plus a list of `open_questions`: exceptions it saw, rules it's unsure of, and cases it hasn't seen.
2. Start the Debrief agent with the open questions and a draft summary injected. It asks them one at a time (at least 3), explains the whole process back in under 60 s, then asks "Is that how it works?"
3. Client tools: `record_answer`, `record_correction`, `teachback_confirmed`. **The debrief is done** when no open questions are left (or the expert marks the remaining ones out of scope) **and** the expert confirms the teach-back.
4. The Work Map UI is a clickable timeline. Each step shows a screenshot, the decision, the reason as the expert's quote, and guardrails as chips (limit / exception / stop-and-ask) with their quotes.

### 5.6 Teach: tutor (new hire)
1. Switch the mode to New hire and load a Work Map and its guide. Start the Tutor agent with them injected. If they're too long, upload them to the agent's knowledge base, as the brief suggests.
2. The same observer runs on the new hire's screen.
3. **The guardrail checker runs on every commit event**, so it fires the moment a wrong value is entered, before Post. On a violation:
   - the agent is nudged to say "Sabine would stop here. Why do you think?" and explain using her quote;
   - the overlay highlights the field;
   - `replay_moment` shows Sabine's screenshots or clip for that step.
4. The tutor sometimes asks the new hire to predict the next decision before they make it.
5. "Where do I…?" questions go to `point_at`. The sidecar returns the window's controls with their rectangles (`tree` command), the best name match wins, and the mascot flies there. If nothing matches, ask vision for coordinates.
6. At the end, the mastery report lists each step as done alone, done after a hint, or caught by a guardrail, and says what to practise next.

**"Before it is saved" trick:** make MiniERP's **Post** a two-step action (Post → confirm dialog), the way real ERPs park an invoice before posting it. That gives the tutor a guaranteed beat to step in.

---

## 6. Security and privacy

### 6.1 Masking
This runs in the sidecar, before anything is stored or sent.

| What | How it's detected | Replaced with |
|---|---|---|
| Passwords | UIA `IsPassword`; field names like password, passcode, PIN, CVV, CVC, security code, OTP, secret; `password: …` in text | Field skipped / `[PASSWORD]` |
| API keys and tokens | Known prefixes (`sk-`, `sk-ant-`, `AKIA`, `ghp_`, `github_pat_`, `xox?-`, `AIza`, `glpat-`), JWTs (`eyJ….….…`), PEM private keys, values after `api_key=` / `token:` / `Bearer`, and any 32+ character high-entropy string without spaces | `[SECRET]` |
| Card numbers | 13–19 digits with optional spaces or dashes, **and** they must pass the Luhn checksum | `[CARD ••••4242]` |
| US SSNs | `\b(?!000\|666\|9\d\d)\d{3}[- ](?!00)\d{2}[- ](?!0000)\d{4}\b` | `[SSN]` |
| IBANs | Country code + 2 digits + 11–30 characters, **and** they must pass the mod-97 check | `[IBAN ••••3000]` (the last 4 stay visible so "supplier changed bank details" can still be a guardrail) |
| Emails, phone numbers | Optional toggles, off by default, because supplier contacts are often part of the workflow | `[EMAIL]`, `[PHONE]` |

`redact.py` is the single place masking happens. Electron sends voice transcripts through it too (`{"cmd":"redact"}`), so an expert who reads a card number aloud gets masked as well. Ship it with unit tests using these test vectors: `4242 4242 4242 4242`, `DE89 3704 0044 0532 0130 00`, `123-45-6789`, `AKIAIOSFODNN7EXAMPLE`.

### 6.2 Skipped by default
- **Password managers** (by process name): 1Password, Bitwarden, KeePass/KeePassXC, LastPass, Dashlane, Keeper, NordPass, Proton Pass.
- **Banking:** a list of bank domains, plus any domain containing "bank" or "banking", plus PayPal, Wise, Revolut and similar. When in doubt, skip.
- **Private windows:** look for "InPrivate", "Incognito" or "Private Browsing" in the window title and in the browser toolbar's accessibility tree. **Check each browser during the spike**, because the markers differ.
- **System screens:** Windows credential dialogs, Windows Security, UAC prompts, the lock screen, and the Apprentice itself.

### 6.3 User controls
- Block any app (by process) or domain (with wildcards, such as `*.mybank.com`). Companies can switch on an optional allow-only mode.
- Pause for 15 min, 1 h, or until tomorrow. During sessions, the **off-the-record** hotkey `Ctrl+Shift+O` pauses everything, mutes the agent's mic, and marks the gap in the timeline.
- The companion always shows **watching** or **not watching**, and why.

### 6.4 Screenshots (sessions only)
- Screenshots cover the foreground window only, so other windows and notification pop-ups never get in.
- Password fields and masked fields are blurred automatically using their accessibility rectangles.
- The guide editor has a manual blur tool.
- No screenshots are ever taken in skipped or blocked apps.

### 6.5 Typed text
- **What's read:** a field's final value, read through accessibility when the user leaves the field (or after 0.8 s idle). That's cleaner than keystrokes (no typos or backspaces) and respects `IsPassword`.
- **What's never read:** password-like fields, skipped or blocked apps and domains, and anything while paused or off the record.
- **No keylogging:** the keyboard hook throws away printable characters at the source. It keeps only timing (typing vs idle) and Enter, Tab, Esc and Ctrl+S as step boundaries.

### 6.6 Storage, deletion, honesty
- Everything lives under `%APPDATA%/apprentice`.
- The **Memory** page lists each app (time spent, size, last seen), shows the raw log and the summary, and deletes per app, per day, or everything.
- Raw ambient logs are kept 7 days by default. Summaries stay until someone deletes them.
- Be upfront in the pitch: masked text goes to the LLM for summaries, session screenshots go to the vision model, and voice goes to ElevenLabs. A per-app "local only" switch (nothing sent, only counted) and on-device models are on the roadmap.

---

## 7. Data contracts

Freeze these in hour 1 and hand-write fixtures, so all four streams can build in parallel against fake data.

```jsonc
// sidecar → main (one JSON object per line on stdout)
{"type":"context","t":1727980000.1,"app":"msedge.exe","key":"browser:minierp.local","title":"Invoice 4471 – MiniERP","blocked":false}
{"type":"blocked","t":1727980001.0,"reason":"password_manager"}          // nothing else about that window
{"type":"click","t":1727980012.4,"x":812,"y":440,"target":{"name":"Post","control_type":"Button","automation_id":"post","rect":[780,425,850,455]},"shot":"shots/1727980012.jpg"}
{"type":"commit","t":1727980015.2,"field":"Cost center","old":"4711","new":"0400","rect":[600,300,760,325],"masked":false}
{"type":"key","t":1727980015.9,"key":"enter"}                           // control keys only
{"type":"activity","t":1727980016.0,"kind":"typing"}                    // typing | mouse | scroll; throttled; no content
{"type":"text","t":1727980030.0,"key":"EXCEL.EXE","title":"Q3 accruals.xlsx","delta":["Accrual – Müller GmbH [IBAN ••••3000]"]}

// main → sidecar (stdin); every reply echoes the id
{"id":7,"cmd":"redact","text":"…"}
{"id":8,"cmd":"tree","max":300}                                          // controls + rects of the foreground window
{"id":9,"cmd":"mode","value":"ambient"}                                  // ambient | session | tutor | paused
```

```jsonc
// guide.json
{
  "id": "g-ap-1", "title": "Process a supplier invoice in MiniERP", "app": "browser:minierp.local",
  "steps": [{
    "id": "st7", "n": 7, "t": 192.4, "kind": "enter",                    // enter | click | select | switch | note
    "title": "Enter 0400 in Cost center", "note": "", "target": "Cost center", "value": "0400",
    "shot": "shots/192400.jpg", "highlight": [600,300,760,325], "blur": [[100,520,400,545]],
    "screen_moment": "Invoice 4471, cost center field",
    "quote": { "text": "Equipment over €5,000 is always capex.", "t": 195 }, "edited": false
  }]
}
```

```jsonc
// workmap.json
{
  "id": "ap-invoices-v1", "role": "Accounts payable clerk", "expert": "Sabine",
  "status": "draft|confirmed", "guide": "g-ap-1", "video": "video.webm",
  "steps": [{
    "id": "s4", "index": 4, "title": "Code the invoice to a cost center",
    "guide_steps": ["st6", "st7"], "t_start": 188, "t_end": 201,
    "decision": "Re-coded from opex (4711) to capex (0400)",
    "reason": { "quote": "Equipment over €5,000 is always capex.", "t": 195, "source": "live|debrief" },
    "guardrails": [{ "id": "g2", "type": "limit|exception|stop_and_ask",
                     "rule": "No asset number, no capex booking", "quote": "…", "t": 197, "source": "live|debrief" }],
    "judgment_call": true
  }],
  "open_questions": [],
  "teachback": { "confirmed": true, "t": 640, "corrections": [] }
}
```

```jsonc
// app_profile.json
{
  "key": "browser:minierp.local", "name": "MiniERP", "minutes": 134, "last_seen": "2026-10-04T15:10:00Z",
  "purpose": "Processing supplier invoices for month-end close",
  "recurring_tasks": [{ "name": "Code invoices to cost centers", "evidence": 14 }],
  "screens_fields": ["Invoice detail: supplier, amount, cost center, asset number"],
  "patterns": ["Equipment over €5,000 is coded to 0400"],
  "exceptions": ["Held a December invoice from Müller GmbH"],
  "open_questions": ["Why do some invoices go for a second approval?"],
  "expert_quotes": [{ "q": "…", "a": "…", "t": "…" }],
  "today": ["Processed 12 invoices", "Held 1", "Sent 2 for approval"],
  "guides": ["g-ap-1"], "workmaps": ["ap-invoices-v1"]
}
```

```jsonc
// privacy.json (defaults)
{
  "mask": { "passwords": true, "secrets": true, "cards": true, "ssn": true, "iban": true, "email": false, "phone": false },
  "skip": { "banking": true, "password_managers": true, "private_windows": true },
  "blocked_apps": [], "blocked_domains": [], "allow_only": null,
  "raw_retention_days": 7, "local_only_apps": []
}
```

**ElevenLabs client tools** (register the same names in the agent dashboard):

| Tool | Agent | What it does |
|---|---|---|
| `record_answer(question, answer_quote, type, related_event_t)` | Interviewer, Debrief | Saves an expert quote with its timestamp |
| `record_correction(step_id, correction_quote)` | Debrief | Patches the draft Work Map |
| `teachback_confirmed()` | Debrief | Ends the debrief and triggers the final merge |
| `point_at(target)` | Tutor | Overlay points at a UI element |
| `replay_moment(step_id)` | Tutor | Plays the expert's screenshots or clip |
| `mark_step(step_id, outcome)` | Tutor | Feeds the mastery report |

**Agent setup:** create three agents (Interviewer, Debrief, Tutor). That's simpler than one agent with overrides. On each one:
- enable the `skip_turn` system tool, and add to the prompt: *"While the expert is narrating their work, call skip_turn unless they ask you something directly."*
- turn on Expressive Mode;
- use `{{role}}` as a dynamic variable;
- allow overrides in the agent's security settings.

---

## 8. Sandbox app: MiniERP (build this, don't skip it)

MiniERP is a single local web page, opened in Edge. It's your demo stage, and it makes every module reliable.
- An invoice list and an invoice form with supplier, amount, description, cost center, asset number, bank details and notes. The actions are Hold, Send for approval, and Post (Post → confirm dialog).
- Put a proper `<label>` or `aria-label` on every field, so accessibility reads clean names.
- **Expert set:**
  - an equipment invoice for €6,400 (moves from opex to capex, needs an asset number);
  - a December invoice from the supplier that double-bills (hold it);
  - an invoice from the Czech subsidiary (needs a second approval).
- **New-hire set** (never shown to the expert): a €7,200 equipment invoice and one routine invoice.
- **Masking demo:** one invoice has an IBAN and a card number in its notes field, so masking shows up visibly in the guide.
- A web coding tool (v0, Lovable or Bolt) can produce this in about 30 minutes. It can also produce the guide editor and the dashboard pages. Those tools can't do the Electron main process or the sidecar; that's Claude Code's job.

---

## 9. Scope

**Must (judged items plus your must-haves):**
1. Sidecar: clicks and the element under them, commits, context, privacy gate, redaction.
2. Interviewer with the timing gate (at least 3 questions, at least 1 about a guardrail).
3. Step capture → editable guide (edit, delete, reorder, blur, PDF export).
4. Debrief with teach-back → Work Map linked to guide steps.
5. Tutor catches the wrong decision before Post.
6. Masking, default skips, block list, off-the-record, watching indicator, delete-all.
7. Ambient per-app text memory and App Profiles.

**Should:** overlay pointer, curiosity questions, the "teach me this app?" popup, video replay, first-run wizard, Markdown/HTML export.

**Could:** "ask your history" over App Profiles, a local MCP server for guardrails (§13), Presidio, German → English.

**Won't:** Goldfish's writing key, dictation, daily briefs, MDM, sync, user accounts.

**With 2 people:** Person 1 takes the sidecar and the LLM pipelines; Person 2 takes voice and UI.
- Ship the Must list only.
- Ambient memory keeps only window titles, commits and App Profiles (no full-text snapshots).
- Replay uses screenshots, not video.

---

## 10. Repo layout

```
apprentice/                     electron-vite (React + TS)
  electron/main.ts, preload.ts
  electron/services/            observer.ts gate.ts steps.ts memory.ts rollup.ts llm.ts tts.ts store.ts
  src/windows/                  Companion.tsx Overlay.tsx Dashboard.tsx
  src/dashboard/                GuideEditor.tsx WorkMap.tsx AppProfiles.tsx Memory.tsx Privacy.tsx Mastery.tsx
  src/agents/                   interviewer.ts debrief.ts tutor.ts   (client tools)
  prompts/                      step_vision.md steps_polish.md question_picker.md workmap_merge.md
                                app_rollup.md guardrail_check.md mastery.md
sidecar/
  observer.py                   threads + JSON-lines protocol
  hooks.py uia.py privacy.py redact.py shots.py
  tests/test_redact.py
  requirements.txt              uiautomation pynput mss pillow
config/privacy.default.json
fixtures/                       hand-written event streams for parallel development
sandbox-erp/                    MiniERP
docs/PLAN.md                    this file
```

---

## 11. Timeline (4 streams; feature freeze at H8)

H0 is when you start building.

| Hours | A: Observer (Python) | B: Voice and sessions | C: Intelligence | D: UI and stage |
|---|---|---|---|---|
| **0:00–1:00** | **Spike:** DPI awareness, pynput click → element name, `IsPassword`, Edge URL, window screenshot with mss | electron-vite scaffold; talk to the Interviewer from an Electron window; test `skip_turn` | Freeze the §7 contracts; write fixtures; draft prompts | MiniERP via a web tool; dashboard shell |
| **1:00–3:00** | Protocol, worker thread, commits, `redact.py` + tests, skip lists, click screenshots with blur | Interviewer: gate, `sendUserActivity`, nudges, `record_answer`; transcripts go through redaction | `steps.ts` merge rules + Polish prompt → guide JSON from fixtures | Guide editor (edit, reorder, delete, blur, PDF) |
| **✅ 3:00** | **Checkpoint 1:** real clicks in MiniERP become masked steps with screenshots in the guide editor, and the agent asks 3 questions at pauses (1 about a guardrail) | | | |
| **3:00–5:00** | Ambient text snapshots, dedupe, per-app logs. **Start ambient on every team laptop now** (block personal apps first) | Debrief agent, teach-back, corrections; optional video | Work Map merge + open questions; App Profile rollups | Work Map timeline; Memory page (delete); Privacy page |
| **✅ 5:00** | **Checkpoint 2:** Capture → Guide → Debrief → confirmed Work Map works end to end; App Profiles exist for 3+ apps | | | |
| **5:00–7:30** | `tree` command, private-window detection, hardening | Tutor: interventions, `replay_moment`, `point_at`, `mark_step`; overlay pointer; "teach me?" popup with TTS | Guardrail checker; mastery report; curiosity questions | App Profiles page; mastery view; first-run wizard |
| **✅ 7:30** | **Checkpoint 3:** the new hire's €7,200 opex mistake is caught before Post, explained in Sabine's words | | | |
| **8:00–10:00** | **Freeze.** Fix bugs, **review the Memory page for anything private**, rehearse the demo 3 times, record a backup video, build the pitch deck | | | |

Starting ambient at around H3:30 gives you about 6 hours of real per-app memory from your own laptops by demo time. That's honest "24/7" data for the hackathon's length, and it tests the masking on real use.

---

## 12. Risks to test early

1. **The agent talks over narration.** ElevenAgents reply to every user utterance by default. Use `skip_turn` and say so in the prompt. Test in hour 1.
   - Fallback: mute the agent's mic outside question windows and transcribe narration separately with Scribe v2 Realtime.
2. **There's no "speak now" call.** Use the `sendUserMessage("[pause] …")` nudge, and tag those messages so they're left out of the Work Map.
   - Alternative: set "take turn after silence" to about 5 s and rely on `sendUserActivity()` to hold the agent back. That gives you less control over what it asks.
3. **Hooks quietly stop.** Windows removes a low-level hook if its callback is slow. Queue only, and do the work on another thread.
4. **Coordinates are off on scaled displays.** Make the sidecar DPI-aware. Convert to Electron's coordinates with `screen.screenToDipPoint()` before drawing the overlay.
5. **Web page content is empty in accessibility.** Launch Edge or Chrome with `--force-renderer-accessibility` for the demo. Inspect the tree with Accessibility Insights for Windows or `inspect.exe`.
6. **Walking the accessibility tree is slow or hangs** (Excel, big web pages). Cap depth, element count and time, and run it on the worker thread.
7. **Elevated apps are invisible.** A normal process can't hook or read "Run as administrator" windows, so keep the demo apps unelevated.
8. **Citrix, RDP and VDI windows have no accessibility tree**, so only vision works there. Many companies run SAP this way. Mention it in the pitch as a known limit.
9. **Antivirus may flag** a process with global keyboard hooks. Test on the demo laptop early.
10. **Private data on stage.** Ambient mode has been watching your laptops all hackathon. Block Slack, WhatsApp and personal email from the start, and review the Memory page before you present.
11. **Overrides and dynamic variables** must be enabled in each agent's security settings, or they're silently ignored.
12. **API keys** stay in the main process (`.env`), never in renderer code.
13. **Build on the Windows laptops** (run Claude Code locally there). A Linux or cloud session can write the code and the platform-neutral parts (redaction and tests, contracts, fixtures, prompts, MiniERP), but it can't run the sidecar, screen capture on Windows, or the overlay.

---

## 13. Stretch goals (cheapest first)

1. **Any language.** The expert speaks German, and the tutor teaches in English. Set the agent language; the Work Map is generated in English anyway.
2. **Agent-ready guardrails.** Export the Work Map and guide as instructions an agent can load. Optionally add a local MCP server so Claude Desktop or Claude Code can read guardrails and App Profiles, the way Goldfish exposes its memory.
   - The tutor itself should use client tools: ElevenAgents run in the cloud, so they could only reach a local MCP server through a public tunnel.
3. **Ask your history.** For example, "What does Sabine usually do in SAP at month-end?", answered by the tutor from App Profiles.
4. **Role seeding from O*NET.** Preload typical tasks for the chosen role into the question picker.
5. **Two experts, one task.** Diff two Work Maps and ask each expert why they differ. Skip unless everything else is done.

---

## 14. Demo script (about 3 minutes)

1. **Hook (15 s):** Sabine has 24 years of experience and retires in 18 months.
2. **Ambient (20 s):** open App Profiles: "This has run on our laptops all hackathon. Here's what it learned about MiniERP and Excel, text only, masked." Alt-tab into a password manager, and the companion shows **Not watching: password manager**.
3. **Capture (50 s):** the expert processes 3 invoices while talking. Steps with screenshots appear live. At a pause, the agent asks "You moved that one to capex. What made you do that?", then later asks a guardrail question.
4. **Map (40 s):** the debrief asks 3 gap questions, then gives the teach-back, and the expert corrects one detail. The Work Map appears next to the editable guide. Blur a region, export the PDF.
5. **Teach (40 s):** the new hire opens the €7,200 equipment invoice and types the opex code. The mascot flies to the field: "Sabine would stop here. Why do you think?" Her screenshots replay, the new hire fixes it, and the mastery report appears.
6. **Trust (10 s):** show the masked card number and IBAN in a step, hit off-the-record, and show delete-all.
7. **Moonshot (15 s):** a curiosity question pops up ("Got a sec? Why do some invoices go for second approval?"). That's the always-on apprentice. Next comes a living company memory that only asks about what's new, and agents that follow the same guardrails.
