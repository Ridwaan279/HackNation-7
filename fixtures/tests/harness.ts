import { mkdir, mkdtemp } from 'node:fs/promises'
import path from 'node:path'
import type { AppContext, Bus, BusEvents, BusRequests } from '@shared/contracts'

export async function harness() {
  const parent = path.resolve(path.basename(process.cwd()) === 'fixtures' ? '.test-output' : 'fixtures/.test-output')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(path.join(parent, 'phase2-'))
  return contextAt(root)
}

export async function contextAt(root: string) {
  const listeners = new Map<string, Set<(payload: any) => void>>()
  const requests = new Map<string, (payload: any) => any>()
  const ipc = new Map<string, (payload: any) => unknown>()
  const broadcasts: { channel: string; payload: any }[] = []
  const bus: Bus = {
    emit: (name, payload) => { for (const listener of listeners.get(name) ?? []) listener(payload) },
    on: (name, callback) => { const set = listeners.get(name) ?? new Set(); set.add(callback); listeners.set(name, set); return () => { set.delete(callback) } },
    handle: (name, callback) => { if (requests.has(name)) throw new Error(`Duplicate request handler: ${name}`); requests.set(name, callback) },
    request: async (name, payload) => { const handler = requests.get(name); if (!handler) throw new Error(`Missing handler: ${name}`); return handler(payload) },
  }
  const ctx: AppContext = {
    bus, paths: { root, shots: path.join(root, 'shots'), memory: path.join(root, 'memory'), sessions: path.join(root, 'sessions'), config: path.join(root, 'config') },
    env: { MODEL_FAST: 'test-fast', MODEL_SMART: 'test-smart' },
    handle: (name, handler) => { if (ipc.has(name)) throw new Error(`Duplicate IPC: ${name}`); ipc.set(name, handler) },
    broadcast: (channel, payload) => { broadcasts.push({ channel, payload }) },
  }
  for (const directory of Object.values(ctx.paths)) await mkdir(directory, { recursive: true })
  // Deliberately a test adapter, never an alternative production redactor.
  bus.handle('observer:redact', ({ text }) => ({ text: text.replaceAll('TEST_SECRET', '[SECRET]') }))
  return {
    ctx, broadcasts,
    emit: <K extends keyof BusEvents>(name: K, value: BusEvents[K]) => bus.emit(name, value),
    request: <K extends keyof BusRequests>(name: K, value: BusRequests[K]['req']) => bus.request(name, value),
    invoke: async <T = unknown>(name: string, payload: unknown): Promise<T> => { const handler = ipc.get(name); if (!handler) throw new Error(`Missing IPC: ${name}`); return await handler(payload) as T },
  }
}
