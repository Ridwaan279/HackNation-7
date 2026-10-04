import type { Bus } from '@shared/contracts'

type Listener = (payload: any) => unknown
type Handler = (req: any) => unknown

export class NoHandlerError extends Error {
  constructor(name: string) {
    super(`no bus handler for "${name}" (service not loaded yet?)`)
  }
}

/** In-process typed bus. Listener errors are logged, never thrown back at the emitter. */
export function createBus(): Bus {
  const listeners = new Map<string, Set<Listener>>()
  const handlers = new Map<string, Handler>()

  const report = (name: string, err: unknown) => console.error(`[bus] listener for ${name} failed:`, err)

  return {
    emit(name, payload) {
      for (const fn of [...(listeners.get(name) ?? [])]) {
        try {
          const r = fn(payload) as Promise<unknown> | undefined
          if (r && typeof r.then === 'function') r.catch((err) => report(name, err))
        } catch (err) {
          report(name, err)
        }
      }
    },
    on(name, fn) {
      let set = listeners.get(name)
      if (!set) listeners.set(name, (set = new Set()))
      set.add(fn)
      return () => {
        set.delete(fn)
      }
    },
    handle(name, fn) {
      if (handlers.has(name)) console.warn(`[bus] "${name}" already has a handler; replacing it`)
      handlers.set(name, fn)
    },
    async request(name, req) {
      const fn = handlers.get(name)
      if (!fn) throw new NoHandlerError(name)
      return (await fn(req)) as any
    },
  }
}
