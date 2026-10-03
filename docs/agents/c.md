# Agent C status

Phase 1 implementation on `agent/c-brain` (2026-10-03). No shared contract changes or edits to A/B-owned code.

## Done

- Read AGENT.md, PLAN.md, shared contracts and all status notes. Built C's first phase only; later milestones remain below.
- MiniERP local demo: labelled invoice form, 3 expert / 2 separate new-hire records, Hold, approval, Post/confirm/cancel, reset, synthetic payment test vectors, password test field. `cd sandbox-erp; npm install; npm run dev` opens it at `http://127.0.0.1:4173`.
- Expert, new-hire and 3-app ambient JSONL fixtures with Unix-second timestamps. Real MiniERP fixture screenshots have pre-masked payment fields; replay rectangles are synthetic.
- `store.ts`: APPDATA paths, atomic JSON writes, serialized JSONL append/delete, safe app directory keys, path/junction rejection, no broad renderer filesystem access.
- `llm.ts`: Anthropic fast/smart wrappers, environment models and main-only key, image input, Zod output validation, bounded provider timeout/retry, sanitized errors, local-only policy checked before calls.
- Independent checks in `fixtures/` avoid creating or editing B's app scaffold. See fixtures/README.md for exact integration APIs and replay limitations.
- Validation: TypeScript strict check passes; 7 brain/replay tests and 3 MiniERP tests pass on Windows. Browser manually verified expert posting, cancel, hold, approval, new-hire correction, read-only posted fields and reset; no browser console errors. Screenshot files and their dimensions validated against replay metadata.

## Stubbed / faked

- All invoice data and replay events are synthetic. Screenshots are browser captures, not sidecar captures. Click images are null; periodic screenshot events carry images.
- Model tests use injected responses; no live model request has been made.
- Phase 2+ services (`steps`, `describe`, question picker, Work Map, memory/rollup, checker, locate, mastery) and dashboard pages are not implemented yet.

## Needs from others

- B: Electron scaffold and listed dependencies; this LLM wrapper requires Zod 4. Load C services via their `init(ctx)` exports. Keep the test harness separate from production dependencies.
- A: create runtime `config/privacy.json`; model calls fail closed until it exists. Fake observer resolves `fixtures/shots/...` relative to repo root and copies screenshots to runtime storage where necessary.
- A/B: Windows UIA/password/screenshot/DPI smoke tests and real session lifecycle. No screenshot blur or privacy claim is validated by browser-only checks.
- B/human: resolve PLAN §5.3's ~90-second question spacing / 3–5 per ten minutes versus M1's >=3 questions in three minutes. Do not silently change the gate.
- Human: PLAN §3 says tutor retains no recording; §5.9 says teach/tutor screenshots are kept. Follow AGENT.md's stricter rule (only teach keeps screenshots) when implementing cleanup.
- B/C integration: a Post confirmation dialog creates an opportunity for intervention but does not guarantee an LLM result beats a quick confirmation. Measure this at M3; avoid claiming guaranteed prevention without a hold/acknowledgement mechanism.

## Known bugs

- End-to-end Capture/Map/Teach is not runnable until A/B and C's later phases are integrated.
- Storage serialization is per process, not a cross-process lock; config writes shared with the sidecar will need coordination.
- Fixture click coordinates and screenshot origins are synthetic and must not be used as evidence that pointer positioning works.
