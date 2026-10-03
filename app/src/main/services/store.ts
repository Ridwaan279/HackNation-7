import { createHash, randomUUID } from 'node:crypto'
import { appendFile, lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { AppContext, ServiceInit } from '@shared/contracts'

/** App keys contain colons and domains. Hashing prevents Windows-invalid names and collisions. */
export function appDirectory(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

export function defaultPaths(appData = process.env.APPDATA): AppContext['paths'] {
  if (!appData || !path.isAbsolute(appData)) throw new Error('An absolute APPDATA directory is required')
  const root = path.join(appData, 'apprentice')
  return { root, sessions: path.join(root, 'sessions'), memory: path.join(root, 'memory'), config: path.join(root, 'config'), shots: path.join(root, 'shots') }
}

/** Only already-redacted data belongs here. Does not register filesystem IPC. */
export class JsonStore {
  readonly root: string
  private readonly pending = new Map<string, Promise<unknown>>()

  constructor(root: string) {
    if (!path.isAbsolute(root)) throw new Error('Store root must be absolute')
    this.root = path.resolve(root)
  }

  file(...parts: string[]): string {
    if (!parts.length || parts.some((part) => !part || part === '.' || part === '..' || /[<>:"/\\|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) {
      throw new Error('Invalid storage path')
    }
    return path.join(this.root, ...parts)
  }

  private async checkPath(file: string): Promise<void> {
    // Reject junctions/symlinks, including existing ancestors of the root.
    const parsed = path.parse(file)
    let current = parsed.root
    for (const part of file.slice(parsed.root.length).split(path.sep)) {
      current = path.join(current, part)
      try {
        if ((await lstat(current)).isSymbolicLink()) throw new Error('Storage links are not allowed')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
    }
  }

  private serialize<T>(file: string, operation: () => Promise<T>): Promise<T> {
    const next = (this.pending.get(file) ?? Promise.resolve()).catch(() => undefined).then(operation)
    this.pending.set(file, next)
    void next.finally(() => { if (this.pending.get(file) === next) this.pending.delete(file) }).catch(() => undefined)
    return next
  }

  async read<T>(parts: string[]): Promise<T | null> {
    const file = this.file(...parts)
    await this.pending.get(file)?.catch(() => undefined)
    await this.checkPath(file)
    try { return JSON.parse(await readFile(file, 'utf8')) as T }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  }

  write(parts: string[], value: unknown): Promise<void> {
    const serialized = JSON.stringify(value, null, 2)
    if (serialized === undefined) return Promise.reject(new Error('Value must be JSON serializable'))
    return this.writeBytes(parts, Buffer.from(`${serialized}\n`))
  }

  async readBytes(parts: string[], maxBytes = 5_000_000): Promise<Buffer> {
    const file = this.file(...parts)
    await this.pending.get(file)?.catch(() => undefined)
    await this.checkPath(file)
    const info = await lstat(file)
    if (!info.isFile() || info.size > maxBytes) throw new Error('Image is too large or unavailable')
    const bytes = await readFile(file)
    if (bytes.length > maxBytes) throw new Error('Image is too large')
    return bytes
  }

  writeBytes(parts: string[], bytes: Buffer): Promise<void> {
    const file = this.file(...parts)
    const snapshot = Buffer.from(bytes)
    return this.serialize(file, async () => {
      await this.checkPath(file)
      await mkdir(path.dirname(file), { recursive: true })
      const temp = `${file}.${randomUUID()}.tmp`
      try {
        await writeFile(temp, snapshot, { flag: 'wx', mode: 0o600 })
        // Windows scanners can briefly lock the destination. Preserve the old
        // document throughout bounded retries; never unlink it to force a write.
        for (let attempt = 0; ; attempt++) {
          try { await rename(temp, file); break }
          catch (error) {
            if (attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
            await delay(20 * 2 ** attempt)
          }
        }
      } finally {
        await unlink(temp).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
      }
    })
  }

  append(parts: string[], value: unknown): Promise<void> {
    const file = this.file(...parts)
    const serialized = JSON.stringify(value)
    if (serialized === undefined) return Promise.reject(new Error('Value must be JSON serializable'))
    return this.serialize(file, async () => {
      await this.checkPath(file)
      await mkdir(path.dirname(file), { recursive: true })
      await appendFile(file, `${serialized}\n`, { encoding: 'utf8', mode: 0o600 })
    })
  }

  async lines<T>(parts: string[]): Promise<T[]> {
    const file = this.file(...parts)
    await this.pending.get(file)?.catch(() => undefined)
    await this.checkPath(file)
    try { return (await readFile(file, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as T) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  }

  async list(parts: string[]): Promise<string[]> {
    const directory = this.file(...parts)
    await this.checkPath(directory)
    try { return (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isFile() && !entry.name.endsWith('.tmp')).map((entry) => entry.name).sort() }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  }

  remove(parts: string[]): Promise<void> {
    const file = this.file(...parts)
    return this.serialize(file, async () => {
      await this.checkPath(file)
      await unlink(file).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
    })
  }
}

const stores = new WeakMap<AppContext, JsonStore>()
export function getStore(ctx: AppContext): JsonStore {
  let store = stores.get(ctx)
  if (!store) { store = new JsonStore(ctx.paths.root); stores.set(ctx, store) }
  return store
}

export const init: ServiceInit = async (ctx) => {
  getStore(ctx)
  for (const directory of Object.values(ctx.paths)) await mkdir(directory, { recursive: true })
}
