// Displays service (Agent A): physical pixels (sidecar, UI Automation, screenshots)
// <-> Electron DIPs (overlay windows). PLAN §5.7.
//
// - 'displays:toDip' converts a physical rect for the ghost/pointer overlay.
// - Compares the sidecar's monitor list with Electron's and emits a
//   'display_mismatch' warning (as an observer:event) if they disagree for more
//   than one sidecar poll, e.g. after a scaling change the sidecar hasn't seen.

import { app, screen } from 'electron'
import type { Display, Rectangle } from 'electron'
import type { Monitor, Rect, ServiceInit } from '@shared/contracts'

const SETTLE_MS = 7000 // the sidecar re-reads monitors every 5 s

export function rectToRectangle([l, t, r, b]: Rect): Rectangle {
  return { x: l, y: t, width: r - l, height: b - t }
}

export function rectangleToRect(rc: Rectangle): Rect {
  return [rc.x, rc.y, rc.x + rc.width, rc.y + rc.height]
}

/** Physical screen rect -> DIP rect, using the scale of the display nearest to it. */
export function physicalToDip(rect: Rect): Rect {
  if (process.platform === 'win32') {
    return rectangleToRect(screen.screenToDipRect(null, rectToRectangle(rect)))
  }
  // Dev on macOS/Linux only: physical == DIP * scale of the primary display.
  const s = screen.getPrimaryDisplay().scaleFactor || 1
  return [rect[0] / s, rect[1] / s, rect[2] / s, rect[3] / s]
}

/** Describe how the sidecar's monitors and Electron's displays disagree ('' if they match). */
export function compareLayouts(monitors: Monitor[], displays: Display[]): string {
  if (!monitors.length) return ''
  if (monitors.length !== displays.length) {
    return `sidecar sees ${monitors.length} monitor(s), Electron sees ${displays.length}`
  }
  const unmatched = displays.filter((d) => {
    const w = Math.round(d.bounds.width * d.scaleFactor)
    const h = Math.round(d.bounds.height * d.scaleFactor)
    return !monitors.some((m) => {
      const mw = m.rect_px[2] - m.rect_px[0]
      const mh = m.rect_px[3] - m.rect_px[1]
      return Math.abs(mw - w) <= 2 && Math.abs(mh - h) <= 2 && Math.abs(m.scale - d.scaleFactor) < 0.01
    })
  })
  if (!unmatched.length) return ''
  return unmatched
    .map((d) => `display ${d.id} (${d.bounds.width}x${d.bounds.height} DIP at ${d.scaleFactor}x) has no matching monitor`)
    .join('; ')
}

export const init: ServiceInit = async (ctx) => {
  await app.whenReady()
  let monitors: Monitor[] = []
  let lastProblem = ''
  let settle: ReturnType<typeof setTimeout> | null = null

  const check = (): void => {
    if (settle) clearTimeout(settle)
    settle = null
    const problem = compareLayouts(monitors, screen.getAllDisplays())
    if (problem && problem !== lastProblem) {
      ctx.bus.emit('observer:event', { type: 'warning', t: Date.now() / 1000, code: 'display_mismatch', detail: problem })
    }
    lastProblem = problem
  }
  const electronChanged = (): void => {
    if (settle) clearTimeout(settle)
    settle = setTimeout(check, SETTLE_MS) // give the sidecar a poll to catch up
  }

  ctx.bus.on('observer:event', (ev) => {
    if (ev.type === 'displays') {
      monitors = ev.monitors
      check()
    }
  })
  screen.on('display-metrics-changed', electronChanged)
  screen.on('display-added', electronChanged)
  screen.on('display-removed', electronChanged)

  ctx.bus.handle('displays:toDip', ({ rect }) => ({ rect: physicalToDip(rect) }))
}
