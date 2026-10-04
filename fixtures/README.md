# Agent C replay and test harness

Run from this folder:

```powershell
npm install
npm run typecheck
npm test
npm run generate
```

This isolated development harness lets C validate `llm.ts` and `store.ts` before B's Electron scaffold arrives. It does not replace `app/package.json`. B should install the dependencies named in AGENT.md; `llm.ts` uses Zod 4's `toJSONSchema`. Tests inject a model transport: no API key, network model call, or bill is needed.

## Replays

- `expert-session.jsonl`: three invoices, capex change and asset number, December hold, Czech approval. Approximately three minutes.
- `newhire-session.jsonl`: unseen EUR 7,200 equipment invoice left in opex, Post review cancelled, then corrected; followed by the routine invoice.
- `ambient-day.jsonl`: a compressed day covering MiniERP, Excel and an example documentation app, each with over ten minutes of activity. Ends in a password-manager block with no identifying context.

All `t` values are Unix **seconds**. Preserve time differences during replay. The files contain only `SidecarEvent` messages; the shell must start a teach/tutor session separately. No synthetic expert answers or confirmed Work Maps are silently injected.

Fixture screenshot paths are **repository-relative**. A's fake observer currently replays the strings without copying files. C's screenshot reader accepts only runtime-root `shots/...` paths. For an integrated fake run, A's replay must copy the fixture images into runtime shots and rewrite their paths. These teach screenshots are not ephemeral. `shots/*.jpg` are real captures of the synthetic MiniERP page; payment fields were replaced with masking tokens before capture. Clicks currently have `shot: null`; periodic shot events exercise image handling. Screenshot metadata matches image dimensions, but the origin and click rectangles are synthetic: these replays do not validate OS pointer accuracy or DPI scaling.

Rebuild the JSONL with `npm run generate` after changing the generator or screenshot dimensions. Live observer redaction and Windows accessibility still require Agent A's smoke test.

## Service integration

Both services export `init: ServiceInit` and can be loaded in any order. Other C services use `getStore(ctx)` and `getLlm(ctx)`; there is no renderer filesystem/model endpoint.

`JsonStore` stores relative path components beneath `ctx.paths.root`. JSON writes are atomic; writes, appends and deletes serialize per file within one process. Missing files return `null`/`[]`; corruption is an error. `appDirectory(key)` hashes app keys into collision-resistant Windows-safe folder names. Keep the human-readable key inside stored documents. These helpers accept **already-redacted data only**.

`getLlm(ctx).fast({appKeys, system, input, schema, images?})` and `.smart(...)` select `ctx.env.MODEL_FAST`/`MODEL_SMART`; the API key stays in the main process environment. Pass every source app key (and process name when applicable), never omit provenance. Calls fail closed when privacy configuration is missing or any source is local-only. Images must already be masked by A. Output is parsed and Zod-validated, with errors that do not expose model input or provider bodies. The wrapper does not itself redact data, persist images, or send startup requests.

## Phase 2: capture and guide editor

`steps.ts` starts a guide on `session:started` (`teach` or `quick_guide`), consumes redacted `observer:event` messages, emits `guide:updated` after changes, and marks the guide saved on `session:stopped`. It merges field clicks with later idle/final commits, handles double-clicks and app switches, and links expert answers to the precise observed event timestamp. `brain:pickQuestion` uses the fast model and the prompt under `app/prompts/`; it asks at least one guardrail question before other types. If the model is unavailable, it asks an evidence-based local question. B's gate remains responsible for pause detection, speaking state, and question budget.

The dashboard is `app/src/renderer/dashboard/index.tsx`, with its CSS and local preload bridge in the same folder. B mounts it on `#/dashboard`; C does not edit B's route or preload. IPC: `guides:list`, `guide:get`, `guide:save`, `guide:image`, `guide:blur`, `guide:exportPdf`. `guide:save` checks a guide revision and redacts user edits through A before writing. `guide:blur` uses only the submitted rectangle; the main process paints an opaque mask into the original screenshot, rewrites guide references, and removes the original. The renderer's data URL is preview data and cannot bypass the mask. PDF export uses Electron's native `printToPDF` and a file save dialog. B must copy `app/prompts/*.md` to `resources/prompts` in production packaging.

For the isolated fixture preview, run `npm run preview` here and open http://127.0.0.1:4174. It uses the real C guide service and editor with synthetic fixture events, a mock vision description, and a test-only Electron backend. `npm run test:electron` checks real Electron image masking, original-image deletion and PDF output. This preview does not prove the full A/B Windows capture flow.
