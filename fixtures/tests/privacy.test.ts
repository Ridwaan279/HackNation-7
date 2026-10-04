import test from 'node:test'
import assert from 'node:assert/strict'
import { createPrivacy, normalizePrivacy } from '../../app/src/main/services/privacy'
import { getStore } from '../../app/src/main/services/store'
import { harness } from './harness'

test('privacy.json: partial files merge over defaults; saves are validated, written and reloaded', async () => {
  assert.equal(normalizePrivacy({ mask: { email: true } }).mask.cards, true)
  assert.equal(normalizePrivacy({ mask: { email: true } }).mask.email, true)
  assert.equal(normalizePrivacy('junk').raw_retention_days, 7)
  const h = await harness()
  let reloads = 0
  h.ctx.bus.handle('observer:reloadConfig', () => { reloads++; return { ok: true } })
  h.ctx.bus.handle('observer:setCapture', ({ key, value }) => { void getStore(h.ctx).write(['config', 'app_modes.json'], { [key]: { capture: value } }); return { ok: true } })
  let off = false
  const privacy = createPrivacy(h.ctx, { offRecord: async () => off, toggleOffRecord: async () => { off = !off } })
  const { privacy: current } = await privacy.get()
  const saved = await privacy.set({ ...current, blocked_apps: ['Slack.exe', 'slack.exe'], blocked_domains: ['*.mybank.com'] })
  assert.deepEqual(saved.privacy.blocked_apps, ['slack.exe'])
  assert.equal(reloads, 1)
  assert.deepEqual((await getStore(h.ctx).read<{ blocked_domains: string[] }>(['config', 'privacy.json']))!.blocked_domains, ['*.mybank.com'])
  await assert.rejects(privacy.set({ ...current, raw_retention_days: 0 }))
  await assert.rejects(privacy.set({ ...current, surprise: true }))
  const modes = await privacy.setCapture('browser:legacy.example', 'vision')
  assert.deepEqual(modes.app_modes, { 'browser:legacy.example': { capture: 'vision' } })
  const paused = await privacy.pause(15)
  assert.equal(off, true)
  assert.ok(paused.paused_until! > Date.now() + 14 * 60_000)
  await privacy.resume()
  assert.equal(off, false)
})
