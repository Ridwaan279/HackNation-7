import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const publicFiles = new Map([
  ['/', ['index.html', 'text/html']],
  ['/app.js', ['app.js', 'text/javascript']],
  ['/data.mjs', ['data.mjs', 'text/javascript']],
  ['/style.css', ['style.css', 'text/css']],
])

export const server = createServer(async (req, res) => {
  const entry = publicFiles.get(new URL(req.url, 'http://localhost').pathname)
  if (!entry || !['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(404).end('Not found')
    return
  }
  try {
    const body = await readFile(new URL(entry[0], import.meta.url))
    res.writeHead(200, {
      'Content-Type': `${entry[1]}; charset=utf-8`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'none'; frame-ancestors 'none'",
    }).end(req.method === 'HEAD' ? undefined : body)
  } catch {
    res.writeHead(500).end('Unable to load MiniERP')
  }
})

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(Number(process.env.PORT || 4173), '127.0.0.1', () => {
    console.log(`MiniERP: http://127.0.0.1:${server.address().port}`)
  })
}
