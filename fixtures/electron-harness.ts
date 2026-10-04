import { app, nativeImage } from 'electron'
import { createServer, type ServerResponse } from 'node:http'
import { mkdir, readFile, mkdtemp, writeFile } from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import type { Guide, SidecarEvent } from '@shared/contracts'
import { createStepsService, printGuidePdf, guideHtml } from '../app/src/main/services/steps'
import { JsonStore } from '../app/src/main/services/store'
import { contextAt } from './tests/harness'

async function main() {
  const root = process.env.APPRENTICE_FIXTURE_ROOT!
  await mkdir(path.join(root, '.preview-data'), { recursive: true })
  const data = await mkdtemp(path.join(root, '.preview-data', 'run-'))
  // Keep all test-only Electron data inside the fixture workspace.
  app.setPath('userData', path.join(data, 'electron'))
  app.setPath('sessionData', path.join(data, 'electron-session'))
  await app.whenReady()
  app.on('window-all-closed', () => { /* hidden export windows must not stop tests or preview */ })
  const harness = await contextAt(data)
  const subscribers = new Set<ServerResponse>()
  const originalBroadcast = harness.ctx.broadcast
  harness.ctx.broadcast = (channel, payload) => {
    originalBroadcast(channel, payload)
    for (const response of subscribers) response.write(`data: ${JSON.stringify({ channel, payload })}\n\n`)
  }
  const service = createStepsService(harness.ctx, {
    describe: async ({ target }) => ({ screen_moment: `Fixture screen: ${target || 'MiniERP invoice review'}.`, target: null }),
    exportPdf: async (html) => {
      const filename = path.join(data, 'exported-guide.pdf')
      await writeFile(filename, await printGuidePdf(html))
      return { canceled: false, path: filename }
    },
  })
  const shots = new JsonStore(harness.ctx.paths.shots)
  const events: SidecarEvent[] = (await readFile(path.join(root, 'expert-session.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  harness.emit('session:started', { id: 'preview-expert', kind: 'teach' })
  for (const event of events) {
    if (event.type === 'shot') {
      const filename = path.basename(event.path)
      await shots.writeBytes(['demo', filename], await readFile(path.join(root, 'shots', filename)))
      event.path = `shots/demo/${filename}`
    }
    harness.emit('observer:event', event)
  }
  harness.emit('session:stopped', { id: 'preview-expert' })
  await service.drain()
  let guide = (await service.list())[0]
  guide = await harness.invoke<Guide>('guide:save', { id: guide.id, revision: guide.revision, edit: { kind: 'rename', title: 'Process supplier invoices' } })

  if (process.argv.includes('--smoke')) {
    const step = guide.steps.find((candidate) => candidate.shot)!
    const old = step.shot!
    const image = nativeImage.createFromBuffer(await shots.readBytes(['demo', path.basename(old)]))
    const before = image.getSize()
    guide = await harness.invoke<Guide>('guide:blur', { id: guide.id, step_id: step.id, revision: guide.revision, data_url: image.toPNG().length ? 'data:image/png;base64,AAAA' : '', regions: [[20, 20, 120, 60]] })
    assert.notEqual(guide.steps.find((candidate) => candidate.id === step.id)!.shot, old)
    await assert.rejects(shots.readBytes(['demo', path.basename(old)]), { code: 'ENOENT' })
    const redactedPath = guide.steps.find((candidate) => candidate.id === step.id)!.shot!
    const redacted = nativeImage.createFromBuffer(await readFile(path.join(data, redactedPath)))
    const pixel = redacted.toBitmap().subarray((25 * before.width + 25) * 4, (25 * before.width + 25) * 4 + 4)
    assert.deepEqual([...pixel], [67, 75, 52, 255])
    const pdf = await printGuidePdf(await guideHtml(harness.ctx, guide))
    assert.equal(pdf.subarray(0, 4).toString(), '%PDF')
    assert.ok(pdf.length > 5000)
    await writeFile(path.join(data, 'smoke-guide.pdf'), pdf)
    await writeFile(process.env.APPRENTICE_SMOKE_RESULT!, JSON.stringify({ passed: true, checks: ['flattened image redaction', 'original screenshot removed', 'native PDF export'], pdfBytes: pdf.length, pdfPath: path.join(data, 'smoke-guide.pdf') }))
    console.log(`Electron smoke passed: flattened redaction, original deletion, native PDF (${pdf.length} bytes).`)
    app.quit()
    return
  }
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url!, 'http://127.0.0.1:4174').pathname
    try {
      if (request.method === 'GET' && pathname === '/events') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
        response.write(': connected\n\n'); subscribers.add(response)
        request.on('close', () => subscribers.delete(response)); return
      }
      if (request.method === 'POST' && pathname === '/ipc') {
        // Preview exposes synthetic data only and accepts requests from its own origin.
        if (request.headers.origin !== 'http://127.0.0.1:4174') { response.writeHead(403).end(); return }
        const chunks: Buffer[] = []; let length = 0
        for await (const chunk of request) { length += chunk.length; if (length > 8_000_000) throw new Error('Request too large'); chunks.push(chunk) }
        const { channel, payload } = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        const result = await harness.invoke(channel, payload)
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result)); return
      }
      const files: Record<string, [string, string]> = { '/': ['index.html', 'text/html'], '/preview.js': ['preview.js', 'text/javascript'], '/preview.css': ['preview.css', 'text/css'] }
      const entry = files[pathname]
      if (request.method !== 'GET' || !entry) { response.writeHead(404).end(); return }
      response.writeHead(200, { 'Content-Type': `${entry[1]}; charset=utf-8`, 'Cache-Control': 'no-store' }).end(await readFile(path.join(root, '.preview-build', entry[0])))
    } catch (error) {
      response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: error instanceof Error ? error.message : 'Preview error' }))
    }
  })
  server.listen(4174, '127.0.0.1', () => console.log('Guide editor fixture preview: http://127.0.0.1:4174'))
}
main().catch((error) => { console.error(error); app.exit(1) })
