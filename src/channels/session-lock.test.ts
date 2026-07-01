import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { assertSessionIdShape, SessionLock } from './session-lock.js'

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function tailSize(lock: SessionLock): number {
  return (lock as unknown as { tails: Map<string, Promise<unknown>> }).tails.size
}

describe('SessionLock', () => {
  it('serializes work for the same session in FIFO order', async () => {
    const lock = new SessionLock()
    const order: string[] = []

    const first = lock.runExclusive('session-a', async () => {
      order.push('first:start')
      await delay(25)
      order.push('first:end')
    })
    const second = lock.runExclusive('session-a', async () => {
      order.push('second:start')
      order.push('second:end')
    })

    await Promise.all([first, second])
    assert.deepEqual(order, [
      'first:start',
      'first:end',
      'second:start',
      'second:end',
    ])
  })

  it('allows different sessions to run in parallel', async () => {
    const lock = new SessionLock()

    // Deterministic concurrency proof — no wall-clock budget (a `Date.now()`
    // deadline flakes under CPU oversubscription, where two genuinely parallel
    // 100ms tasks can still wall-clock past the budget when descheduled). Both
    // tasks must be in-flight simultaneously before either is allowed to
    // finish: each arrives at a barrier that only releases once BOTH have
    // arrived. If the lock serialized different sessions, session-b's task
    // would not start until session-a's returned — but session-a is parked on
    // the barrier waiting for session-b, so the two would deadlock and the
    // node:test per-test timeout would fail this honestly. Reaching the
    // assertion proves the two sessions overlapped.
    let arrived = 0
    let releaseBarrier!: () => void
    const barrier = new Promise<void>(resolve => {
      releaseBarrier = resolve
    })
    const enterAndWaitForBoth = async () => {
      arrived += 1
      if (arrived === 2) {
        releaseBarrier()
      }
      await barrier
    }

    await Promise.all([
      lock.runExclusive('session-a', enterAndWaitForBoth),
      lock.runExclusive('session-b', enterAndWaitForBoth),
    ])

    assert.equal(arrived, 2, 'both sessions were in-flight at the same time')
  })

  it('does not let a failed task poison the next task for the same session', async () => {
    const lock = new SessionLock()

    await assert.rejects(
      lock.runExclusive('session-a', async () => {
        throw new Error('boom')
      }),
      /boom/,
    )

    const value = await lock.runExclusive('session-a', async () => 'ok')
    assert.equal(value, 'ok')
    assert.equal(tailSize(lock), 0)
  })

  it('cleans tails after many unique sessions', async () => {
    const lock = new SessionLock()
    await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        lock.runExclusive(`session-${index}`, async () => index),
      ),
    )
    assert.equal(tailSize(lock), 0)
  })

  it('validates session id shape before it can become a storage path', () => {
    const invalid = ['', '   ', '.', '..', 'a/b', 'a\\b', 'a\0b']
    for (const value of invalid) {
      assert.throws(() => assertSessionIdShape(value), /Invalid sessionId/)
    }

    for (const value of ['feishu-alice', 'chat:abc', 'fresh-123']) {
      assert.doesNotThrow(() => assertSessionIdShape(value))
    }
  })
})
