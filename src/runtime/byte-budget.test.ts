import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Readable } from 'node:stream'

import { ByteBudget, STREAM_RESERVATION_BYTES, withByteBudget } from './byte-budget.js'
import type { DataPlane } from './types.js'

function fakePlane(sizes: Record<string, number>): DataPlane {
  return {
    kind: 'host-direct',
    independentFromControl: true,
    reliability: 'fs-semantic',
    stat: async pathname => ({
      size: sizes[pathname] ?? 0,
      isFile: true,
      isDirectory: false,
      mtimeMs: 0,
    }),
    readFile: async pathname => Buffer.alloc(sizes[pathname] ?? 0),
    createReadStream: async () => Readable.from([Buffer.alloc(3), Buffer.alloc(4)]),
    writeFile: async () => {},
    readdir: async () => [],
  } satisfies DataPlane
}

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

test('streaming reads reserve their in-flight bytes until the stream ends', async () => {
  const budget = new ByteBudget(10)
  const plane = withByteBudget(fakePlane({ '/small': 7 }), budget)
  const stream = await plane.createReadStream!('/small')
  // Small files reserve their actual size (min(size, STREAM_RESERVATION_BYTES)).
  assert.equal(budget.inUseBytes, 7)
  for await (const _chunk of stream) {
    // drain
  }
  assert.equal(budget.inUseBytes, 0)
  assert.equal(budget.peakInUseBytes, 7)
})

test('streaming a file larger than the whole budget succeeds with a constant reservation', async () => {
  // Regression (0.4.x review §3.7a): createReadStream used to acquire the full
  // stat().size, so a file > maxConcurrentIoBytesMb was rejected outright even
  // though the stream only ever holds ~one buffer of memory — defeating the
  // very point of the bounded-memory streaming path (Read on a huge log,
  // SendFile cloud upload of a > budget artifact).
  const budget = new ByteBudget(8 * 1024 * 1024)
  const plane = withByteBudget(fakePlane({ '/huge': 100 * 1024 * 1024 }), budget)
  const stream = await plane.createReadStream!('/huge')
  assert.equal(budget.inUseBytes, STREAM_RESERVATION_BYTES)
  for await (const _chunk of stream) {
    // drain
  }
  assert.equal(budget.inUseBytes, 0)
})

test('a long-lived stream does not park its file size and starve whole-buffer IO', async () => {
  // Regression (0.4.x review §3.7b): a stream used to hold its FULL file size
  // for its entire lifetime (e.g. a chunked cloud upload running minutes), so
  // one big stream plus a queued request head-of-line blocked every small
  // whole-buffer read/write process-wide.
  const budget = new ByteBudget(10 * 1024 * 1024)
  const plane = withByteBudget(
    fakePlane({ '/big-stream': 8 * 1024 * 1024, '/small-read': 5 * 1024 * 1024 }),
    budget,
  )
  const stream = await plane.createReadStream!('/big-stream')
  // Old code reserved the full 8 MiB here; new code caps at STREAM_RESERVATION_BYTES.
  assert.equal(budget.inUseBytes, STREAM_RESERVATION_BYTES)
  // With the stream still open, a 5 MiB whole-buffer read must fit (4+5 <= 10 MiB).
  const content = await plane.readFile('/small-read')
  assert.equal(content.length, 5 * 1024 * 1024)
  for await (const _chunk of stream) {
    // drain
  }
  assert.equal(budget.inUseBytes, 0)
})
