import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import path from 'node:path'
import electron from 'electron'

const root = fileURLToPath(new URL('.', import.meta.url))
const output = path.join(root, '.preview-build')
await mkdir(output, { recursive: true })
await build({ entryPoints: [path.join(root, 'preview-entry.tsx')], outfile: path.join(output, 'preview.js'), bundle: true, platform: 'browser', jsx: 'automatic', tsconfigRaw: {}, alias: { react: path.join(root, 'node_modules/react'), 'react-dom': path.join(root, 'node_modules/react-dom') } })
await build({ entryPoints: [path.join(root, 'electron-harness.ts')], outfile: path.join(output, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], tsconfigRaw: {}, alias: { zod: path.join(root, 'node_modules/zod'), '@anthropic-ai/sdk': path.join(root, 'node_modules/@anthropic-ai/sdk') } })
await writeFile(path.join(output, 'index.html'), '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Apprentice | Guide editor preview</title><link rel="stylesheet" href="/preview.css"><style>body{margin:0}</style></head><body><div id="root"></div><script src="/preview.js"></script></body></html>')
const smokeResult = path.join(output, `smoke-${Date.now()}.json`)
const env = { ...process.env, APPRENTICE_FIXTURE_ROOT: root, APPRENTICE_SMOKE_RESULT: smokeResult }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(electron, [path.join(output, 'main.cjs'), ...process.argv.slice(2)], { stdio: 'inherit', windowsHide: true, env })
child.on('error', (error) => { console.error(error.message); process.exit(1) })
child.on('exit', async (code) => {
  if (process.argv.includes('--smoke')) {
    try { console.log(JSON.parse(await readFile(smokeResult, 'utf8'))) }
    catch { console.error('Electron did not produce a smoke-test completion result.'); process.exit(1) }
  }
  process.exit(code ?? 1)
})
process.on('SIGINT', () => child.kill())
