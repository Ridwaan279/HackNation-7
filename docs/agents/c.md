# Agent C status

Phase 2 implementation on `agent/c-brain` (2026-10-04). C-owned files only; guide contract additions were committed separately.

## Done

- Read AGENT.md, PLAN.md, shared contracts and A's pushed status notes. Built C's first two phases; M1 integration remains pending B's scaffold and A's Windows smoke test.
- MiniERP local demo: labelled invoice form, 3 expert / 2 separate new-hire records, Hold, approval, Post/confirm/cancel, reset, synthetic payment test vectors, password test field. `cd sandbox-erp; npm install; npm run dev` opens it at `http://127.0.0.1:4173`.
- Expert, new-hire and 3-app ambient JSONL fixtures with Unix-second timestamps. Real MiniERP fixture screenshots have pre-masked payment fields; replay rectangles are synthetic.
- `store.ts`: APPDATA paths, atomic JSON writes, serialized JSONL append/delete, safe app directory keys, path/junction rejection, no broad renderer filesystem access.
- `llm.ts`: Anthropic fast/smart wrappers, environment models and main-only key, image input, Zod output validation, bounded provider timeout/retry, sanitized errors, local-only policy checked before calls.
- Independent checks in `fixtures/` avoid creating or editing B's app scaffold. See fixtures/README.md for exact integration APIs and replay limitations.
- Validation: TypeScript strict check passes; 7 brain/replay tests and 3 MiniERP tests pass on Windows. Browser manually verified expert posting, cancel, hold, approval, new-hire correction, read-only posted fields and reset; no browser console errors. Screenshot files and their dimensions validated against replay metadata.
- Phase 2 `steps.ts`: live guide updates from clicks, commits, keys and window switches; idle/final commit coalescing; precise answer-to-step links; redacted editor edits; revision checks; `brain:pickQuestion` with required guardrail and local fallback.
- Phase 2 `describe.ts`: masked step descriptions and unnamed target names; ambient ephemeral description saved as text with screenshot deleted even on failure; tutor captures deleted.
- Guide editor (`app/src/renderer/dashboard/`): edit, delete, merge, reorder, notes, hide/show screenshot, opaque area redaction and PDF export. Main process paints selected regions into the original bitmap and removes the original after updating guide references.
- Checks: strict TypeScript, 17 fixture/brain tests, 3 MiniERP tests, Electron smoke for actual image pixels and native PDF. Browser preview verified editing, screenshot hide/show and redaction controls. `cd fixtures; npm run preview` starts the isolated editor preview at port 4174.

## Stubbed / faked

- All invoice data and replay events are synthetic. Screenshots are browser captures, not sidecar captures. Click images are null; periodic screenshot events carry images.
- Model tests use injected responses; no live model request has been made.
- Phase 3+ services (Work Map, memory/rollup, checker, locate, mastery) and remaining dashboard pages are not implemented yet.
- The guide editor preview uses synthetic replay and mock descriptions. No live Anthropic call or true A/B end-to-end Electron session has run.

## Needs from others

- B: Electron scaffold and listed dependencies; this LLM wrapper requires Zod 4. Load C services via their `init(ctx)` exports. Keep the test harness separate from production dependencies.
- A: create runtime `config/privacy.json`; model calls fail closed until it exists. A's current `FakeReplay` does not copy fixture screenshot files or rewrite paths. To exercise descriptions in an integrated fake run, copy fixture images to runtime `shots/` and emit runtime-relative paths. Fake redaction currently returns input unchanged, so it cannot validate masking.
- A: `FakeReplay` caps every gap at 3 seconds. The M1 pause timing smoke test must use the real observer or an uncapped replay.
- B: mount C's `app/src/renderer/dashboard/index.tsx` on `#/dashboard` and copy `app/prompts/*.md` into `resources/prompts` when packaging. `ctx.handle` should register C IPC unchanged, and `guide:updated` should reach the panel. `brain:pickQuestion` only chooses content; B still gates timing and budget.
- A/B: Windows UIA/password/screenshot/DPI smoke tests and real session lifecycle. No screenshot blur or privacy claim is validated by browser-only checks.
- B/human: resolve PLAN §5.3's ~90-second question spacing / 3–5 per ten minutes versus M1's >=3 questions in three minutes. Do not silently change the gate.
- Human: PLAN §3 says tutor retains no recording; §5.9 says teach/tutor screenshots are kept. Follow AGENT.md's stricter rule (only teach keeps screenshots) when implementing cleanup.
- B/C integration: a Post confirmation dialog creates an opportunity for intervention but does not guarantee an LLM result beats a quick confirmation. Measure this at M3; avoid claiming guaranteed prevention without a hold/acknowledgement mechanism.

## Known bugs

- End-to-end Capture/Map/Teach is not runnable until A/B and C's later phases are integrated.
- Storage serialization is per process, not a cross-process lock; config writes shared with the sidecar will need coordination.
- Fixture click coordinates and screenshot origins are synthetic and must not be used as evidence that pointer positioning works.
- `guide:blur` uses a permanent opaque mask rather than a reversible Gaussian blur. This is intentional for privacy. Very large screenshots over 5 MB are rejected by the current image reader and need downscaling upstream.
