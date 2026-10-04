/** What the preload exposes as `window.apprentice` in every window. */
export interface ApprenticeApi {
  /** Renderer -> main request (ipcMain.handle registered with ctx.handle). */
  invoke<T = unknown>(channel: string, payload?: unknown): Promise<T>
  /** Main -> renderer broadcast. Returns an unsubscribe function. */
  on<T = unknown>(channel: string, cb: (payload: T) => void): () => void
}
