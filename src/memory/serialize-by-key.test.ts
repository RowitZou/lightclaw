import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'

import { serializeByKey, resetSerializeByKeyForTest } from './serialize-by-key.js'

afterEach(() => {
  resetSerializeByKeyForTest()
})

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

test('same key runs one at a time, in arrival order (no overlap)', async () => {
  const events: string[] = []
  const g1 = deferred<void>()
  const g2 = deferred<void>()

  const p1 = serializeByKey('k', async () => {
    events.push('start1')
    await g1.promise
    events.push('end1')
    return 1
  })
  const p2 = serializeByKey('k', async () => {
    events.push('start2')
    await g2.promise
    events.push('end2')
    return 2
  })

  // Let microtasks settle: only the first should have started.
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.deepEqual(events, ['start1'], 'second call must NOT start while the first is in flight')

  g1.resolve()
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.deepEqual(events, ['start1', 'end1', 'start2'], 'second starts only after the first ends')

  g2.resolve()
  assert.equal(await p1, 1)
  assert.equal(await p2, 2)
  assert.deepEqual(events, ['start1', 'end1', 'start2', 'end2'])
})

test('different keys run concurrently (no cross-key blocking)', async () => {
  const events: string[] = []
  const gA = deferred<void>()

  const a = serializeByKey('A', async () => {
    events.push('startA')
    await gA.promise
    events.push('endA')
  })
  const b = serializeByKey('B', async () => {
    events.push('startB')
  })

  // B must run even though A is still blocked — keys are independent.
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(events.includes('startB'), 'B (different key) runs while A is in flight')
  assert.ok(!events.includes('endA'), 'A is still blocked')

  gA.resolve()
  await Promise.all([a, b])
})

test('a rejected run does not wedge the chain for that key', async () => {
  const ran: string[] = []
  const p1 = serializeByKey('k', async () => {
    ran.push('one')
    throw new Error('boom')
  })
  const p2 = serializeByKey('k', async () => {
    ran.push('two')
    return 'ok'
  })

  await assert.rejects(p1, /boom/)
  assert.equal(await p2, 'ok', 'the next run executes even though the prior threw')
  assert.deepEqual(ran, ['one', 'two'])
})
