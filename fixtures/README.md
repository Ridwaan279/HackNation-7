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

Screenshot paths are **repository-relative**. A's fake observer should resolve them relative to the repository root (not `app/`) and copy images into the runtime shots folder before feeding a service that deletes ephemeral captures. These teach screenshots are not ephemeral. `shots/*.jpg` are real captures of the synthetic MiniERP page; payment fields were replaced with masking tokens before capture. Clicks currently have `shot: null`; periodic shot events exercise image handling. Screenshot metadata matches image dimensions, but the origin and click rectangles are synthetic: these replays do not validate OS pointer accuracy or DPI scaling.

Rebuild the JSONL with `npm run generate` after changing the generator or screenshot dimensions. Live observer redaction and Windows accessibility still require Agent A's smoke test.

## Service integration

Both services export `init: ServiceInit` and can be loaded in any order. Other C services use `getStore(ctx)` and `getLlm(ctx)`; there is no renderer filesystem/model endpoint.

`JsonStore` stores relative path components beneath `ctx.paths.root`. JSON writes are atomic; writes, appends and deletes serialize per file within one process. Missing files return `null`/`[]`; corruption is an error. `appDirectory(key)` hashes app keys into collision-resistant Windows-safe folder names. Keep the human-readable key inside stored documents. These helpers accept **already-redacted data only**.

`getLlm(ctx).fast({appKeys, system, input, schema, images?})` and `.smart(...)` select `ctx.env.MODEL_FAST`/`MODEL_SMART`; the API key stays in the main process environment. Pass every source app key (and process name when applicable), never omit provenance. Calls fail closed when privacy configuration is missing or any source is local-only. Images must already be masked by A. Output is parsed and Zod-validated, with errors that do not expose model input or provider bodies. The wrapper does not itself redact data, persist images, or send startup requests.
