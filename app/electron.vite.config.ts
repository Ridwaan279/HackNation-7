import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Paths are relative to app/ (npm scripts run from there).
const shared = resolve('../shared')

export default defineConfig({
  main: {
    resolve: { alias: { '@shared': shared } },
  },
  preload: {
    resolve: { alias: { '@shared': shared } },
  },
  renderer: {
    resolve: { alias: { '@shared': shared, '@renderer': resolve('src/renderer') } },
    plugins: [react()],
    // shared/ lives outside app/, so the dev server must be allowed to serve it.
    server: { fs: { allow: [resolve('..')] } },
  },
})
