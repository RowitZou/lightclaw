import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ByteBudget } from './byte-budget.js'

test('ByteBudget queues excess work and never exceeds its byte ceiling', async () => {
  const budget = new ByteBudget(10)
  const first = await budget.acquire(7)
  let secondAcquired = false
  const secondPromise = budget.acquire(6).then(release => {
    secondAcquired = true
    return release
  })

  await Promise.resolve()
  assert.equal(secondAcquired, false)
  assert.equal(budget.inUseBytes, 7)
  assert.ok(budget.peakInUseBytes <= 10)

  first()
  const second = await secondPromise
  assert.equal(secondAcquired, true)
  assert.equal(budget.inUseBytes, 6)
  assert.ok(budget.peakInUseBytes <= 10)
  second()
  assert.equal(budget.inUseBytes, 0)
})

test('ByteBudget release advances queued work in FIFO order', async () => {
  const budget = new ByteBudget(10)
  const releaseFirst = await budget.acquire(10)
  const order: number[] = []
  const second = budget.acquire(4).then(release => {
    order.push(2)
    return release
  })
  const third = budget.acquire(3).then(release => {
    order.push(3)
    return release
  })

  releaseFirst()
  const releaseSecond = await second
  const releaseThird = await third
  assert.deepEqual(order, [2, 3])
  releaseSecond()
  releaseThird()
})
