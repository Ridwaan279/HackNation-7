# Protégé demo film

A 66-second cinematic demo of Protégé, rendered from code. The page in this folder is a 1920×1080 stage with a Three.js layer (the 3D ghost, Sabine's knowledge orbs dissolving into particles, iridescent bubbles, the Work Map constellation and the privacy shield) and animated mock-ups of MiniERP and the Protégé workspace. Every frame is a pure function of time, so the render is deterministic.

| Time | Beat | What you see |
|---|---|---|
| 0:00 | **The loss** | Sabine's 24 years of know-how as a constellation of orbs. "18 months until she retires": the orbs dissolve into particles |
| 0:08 | **Reveal** | The particles swirl into the 3D ghost. Impact, flare, the Protégé wordmark |
| 0:14 | **01 Capture** | MiniERP in 3D perspective: an accessibility scan tags every field, the cost center changes from 6100 to 0400, the IBAN is masked, and steps appear live in the panel. The ghost asks "You moved that one to capex. What made you do that?" and Sabine answers |
| 0:29 | **02 Map** | The steps become a 3D Work Map (decision, guardrail ring, Sabine's quote), then the Work Map page gets stamped "Confirmed by Sabine" |
| 0:40 | **03 Teach** | A new hire codes the €7,200 equipment invoice to opex and heads for Post. Time freezes, the ghost flies to the field ("Sabine would stop here. Why do you think?"), Sabine's step replays, the hire fixes it and the invoice posts, followed by the mastery report |
| 0:54 | **Trust, always on** | A shield around the ghost with masked IBAN and card numbers, then App Profiles for every app |
| 1:00 | **End card** | Protégé. Show it once. Protégé remembers. |

## Build it

```bash
cd video
npm install                      # three, fonts, playwright (uses the preinstalled Chromium)
node render.mjs                  # frames -> out/silent.mp4 (about 10-20 min with SwiftShader)
node audio.mjs                   # ElevenLabs voices, music and sound effects -> audio/
node mix.mjs                     # mix + mux -> out/protege-demo.mp4
```

- `node render.mjs --preview 11.8,23,47.5` writes stills to `out/preview/` for quick checks. `--from 40 --to 54` renders one section.
- `node audio.mjs` needs `ELEVENLABS_API_KEY` (in the environment or `app/.env`) and network access to `api.elevenlabs.io`. It makes:
  - **Voices** (Text to Speech, `eleven_multilingual_v2`): a narrator (George), the ghost (Sarah, the same voice as the Protégé website) and Sabine (Lily). Override them with `NARRATOR_VOICE_ID`, `GHOST_VOICE_ID` and `SABINE_VOICE_ID`.
  - **Music** (Music API, `music_v1`): a composition plan with one section per scene, so the score turns where the picture does.
  - **Sound effects** (Text to Sound, `eleven_text_to_sound_v2`): whooshes, the reveal impact, UI clicks, the scan sweep, the time-freeze hit and chimes. Some prompts reuse the desktop app's own cue prompts from `app/src/main/services/tts.ts`.

  Files that already exist are kept, so re-running costs nothing. Use `--force` to regenerate.
- `node audio.mjs --local` synthesises an offline score and sound effects (no voices). It's a stand-in for when ElevenLabs can't be reached. `mix.mjs` uses ElevenLabs `.mp3` stems wherever they exist and falls back to the local `.wav` stems.

All timing lives in `cues.js`: scene boundaries, the spoken lines (with their slots; a clip that runs long is sped up by at most 1.2× in the mix), sound-effect cue times and the music plan. Change the script there.

`out/` and `audio/` are build output. The finished film is copied to `video/protege-demo.mp4`.

## Technical walkthrough (59 s)

`walkthrough/` is a second film on the same pipeline: its own `index.html`, `scene.js`, `walk.css` and `cues.js` (script, voice slots, sound effects and music plan), reusing `film.css`, the ghost and the MiniERP mock-ups. It is authored at its delivered length, 59 s.

| Time | Beat | What you see |
|---|---|---|
| 0:00 | **The onboarding gap** | One recorded hour on a year-long timeline; the habits outside it are struck through as "never mentioned" until Protégé fills the whole year |
| 0:08 | **01 Windows UI Automation** | MiniERP's accessibility tree (control types, names, values) with the password field skipped and the IBAN masked; then an expert records a walkthrough: each click takes a screenshot that becomes a step, with the IBAN and PIN blurred (UI Automation → privacy gate → mask + blur → step guide) |
| 0:21 | **02 Always on, every expert** | Four experts in four apps stream masked events into the ghost while a day counter runs to 365; habits nobody mentioned pop out |
| 0:31 | **03 A growing knowledge base** | A knowledge graph grows app by app; App Profiles and "Ready to teach" fill up |
| 0:40 | **04 Guided pointing** | A new hire is stuck; the ghost flies to the exact button an expert used and highlights it (brain:locate → observer:tree → displays:toDip → overlay), while the new hire keeps their own mouse (click-through overlay) |
| 0:53 | **End card** | Protégé. Always learning. Ready to teach anyone. |

```bash
node render.mjs --film walkthrough --fps 15   # -> out/walkthrough/silent.mp4 (--fps 15 renders half the frames)
node audio.mjs --film walkthrough             # -> audio/walkthrough/
node mix.mjs --film walkthrough               # -> out/walkthrough/protege-walkthrough.mp4 (30 fps, ~9 Mbit/s)
```

The finished film is copied to `video/protege-walkthrough.mp4`.

## 59 s showcase with real footage

`video/protege-demo.mp4` is now a 59 s cut that mixes the cinematic film with three inserts of real footage from the Windows desktop app (`footage/app-session.mp4`), each in a framed plate labelled "Real footage":

| Time | Segment |
|---|---|
| 0:00 | Film: the loss, the reveal |
| 0:12.7 | **Real app**: name the task, press record, the ghost greets the expert in the document |
| 0:18.7 | Film: capture (accessibility scan, masking, the ghost asks why) |
| 0:28.1 | **Real app**: Building the Work Map, then the spoken debrief with the ghost's questions |
| 0:33.6 | Film: the Work Map page, confirmed; then teach (the €7,200 mistake caught before Post) |
| 0:49.3 | **Real app**: Company profile, what Protégé knows and privacy at a glance |
| 0:53.5 | Film: end card |

The edit list, narration over the footage, sound effects and music plan live in `showcase/cues.js`; film lines and effects are moved to the cut automatically.

```bash
node render.mjs --fps 15            # the film on its 66 s authored timeline -> out/silent.mp4 (skip if it exists)
node showcase/edit.mjs              # film + framed footage, crossfaded -> out/showcase/silent.mp4
node audio.mjs --film showcase      # voices, effects and music -> audio/showcase/ (reuses files that exist)
node mix.mjs --film showcase        # -> out/showcase/protege-demo.mp4, copied to video/protege-demo.mp4
```
