import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { init } from '../../app/src/main/services/gate'
import { harness } from './harness'

// One session played through on a fake clock (the gate keeps module state, so this is one test).
test('gate asks at idle moments, at most twice in a row, and again after activity', async () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_000_000 })
  try {
    const h = await harness()
    let picks = 0
    h.ctx.bus.handle('brain:pickQuestion', () => {
      picks++
      return null // nothing specific: idle moments must still produce a question
    })
    await init(h.ctx)
    const nudges = () => h.broadcasts.filter((b) => b.channel === 'agent:command' && b.payload.op === 'nudge')
    const advance = async (seconds: number) => {
      for (let i = 0; i < seconds * 2; i++) {
        mock.timers.tick(500)
        await new Promise((r) => setImmediate(r))
      }
    }

    h.emit('session:started', { id: 's-1', kind: 'teach' })
    await h.invoke('agent:status', { status: 'connected', mode: 'listening', agent: 'interviewer' })

    await advance(9)
    assert.equal(nudges().length, 0, 'nothing in the first seconds of a session')

    await advance(3)
    assert.equal(nudges().length, 1, 'idle since the start: the ghost asks')
    assert.match(nudges()[0].payload.text, /^\[pause\] The expert has paused/)
    assert.ok(picks >= 1, 'the picker is consulted first')

    await advance(21)
    assert.equal(nudges().length, 2, 'still idle: a second question after the gap')

    await advance(60)
    assert.equal(nudges().length, 2, 'no third idle question without any input')

    h.emit('observer:event', { type: 'activity', t: 1, kind: 'mouse' })
    await advance(7)
    assert.equal(nudges().length, 3, 'after activity and a quiet moment, it asks again')

    await h.invoke('agent:status', { mode: 'speaking' })
    h.emit('observer:event', { type: 'activity', t: 2, kind: 'mouse' })
    await advance(30)
    assert.equal(nudges().length, 3, 'never while the agent is speaking')
  } finally {
    mock.timers.reset()
  }
})
