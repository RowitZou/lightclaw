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
    const startedAt = Date.now()

    await Promise.all([
      lock.runExclusive('session-a', () => delay(100)),
      lock.runExclusive('session-b', () => delay(100)),
    ])

    assert.ok(Date.now() - startedAt < 170)
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
