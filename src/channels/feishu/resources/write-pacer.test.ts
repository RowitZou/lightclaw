import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { paceWrite, setWritePacerTimingForTests } from './write-pacer.js'

interface FakeTiming {
  nowMs: number
  sleeps: number[]
}

function installFakeTiming(): FakeTiming {
  const state: FakeTiming = { nowMs: 0, sleeps: [] }
  setWritePacerTimingForTests({
    now: () => state.nowMs,
    sleep: async ms => {
      state.sleeps.push(ms)
      state.nowMs += ms
    },
  })
  return state
}

afterEach(() => {
  setWritePacerTimingForTests(null)
})

describe('paceWrite', () => {
  it('spaces sequential awaited calls on the same key by the minimum interval', async () => {
    const timing = installFakeTiming()
    const startTimes: number[] = []
    // Serial awaited calls — the promise chain is settled between calls, so
    // only the persisted per-key slot timestamp can carry the spacing.
    for (let i = 0; i < 3; i++) {
      await paceWrite('doc-a', async () => {
        startTimes.push(timing.nowMs)
      })
    }
    assert.deepEqual(timing.sleeps, [350, 350], 'second and third calls each wait one interval')
    assert.deepEqual(startTimes, [0, 350, 700])
  })

  it('serializes concurrent calls on the same key in submission order', async () => {
    const timing = installFakeTiming()
    const order: number[] = []
    await Promise.all([
      paceWrite('doc-a', async () => { order.push(1) }),
      paceWrite('doc-a', async () => { order.push(2) }),
      paceWrite('doc-a', async () => { order.push(3) }),
    ])
    assert.deepEqual(order, [1, 2, 3])
    assert.deepEqual(timing.sleeps, [350, 350])
  })

  it('does not make different keys wait on each other', async () => {
    const timing = installFakeTiming()
    await paceWrite('doc-a', async () => {})
    await paceWrite('doc-b', async () => {})
    assert.deepEqual(timing.sleeps, [], 'distinct documents are independent')
  })

  it('a rejected call still returns its error and does not poison the chain', async () => {
    const timing = installFakeTiming()
    await assert.rejects(
      paceWrite('doc-a', async () => { throw new Error('boom') }),
      /boom/,
    )
    const result = await paceWrite('doc-a', async () => 'ok')
    assert.equal(result, 'ok', 'the key stays usable after a failure')
    assert.deepEqual(timing.sleeps, [350], 'the follow-up call still respects spacing')
  })

  it('returns the wrapped function result', async () => {
    installFakeTiming()
    const result = await paceWrite('doc-a', async () => 42)
    assert.equal(result, 42)
  })
})
