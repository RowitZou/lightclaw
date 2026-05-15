import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import {
  describeImagesAdaptive,
  joinSegmentsForLLM,
} from './describe-adaptive.js'
import {
  readBatchCeiling,
  _resetCacheForTests,
} from './batch-size-cache.js'

let prevHome: string | undefined
let homeDir: string

beforeEach(() => {
  homeDir = mkdtempSync(path.join(tmpdir(), 'lightclaw-describe-adaptive-'))
  prevHome = process.env.LIGHTCLAW_HOME
  process.env.LIGHTCLAW_HOME = homeDir
  _resetCacheForTests()
})

afterEach(() => {
  if (prevHome === undefined) {
    delete process.env.LIGHTCLAW_HOME
  } else {
    process.env.LIGHTCLAW_HOME = prevHome
  }
  rmSync(homeDir, { recursive: true, force: true })
  _resetCacheForTests()
})

function fakeImage(seq: number) {
  return { buffer: Buffer.from(`image-${seq}`), mimeType: 'image/jpeg' }
}

class BatchTooBigError extends Error {
  status = 400
  constructor(public details: string) {
    super('image_count_exceeded')
  }
}

describe('describeImagesAdaptive', () => {
  it('returns empty result for empty input', async () => {
    const result = await describeImagesAdaptive({
      images: [],
      endpoint: 'e',
      baseUrl: undefined,
      upstreamModel: 'm',
      call: async () => ({ text: 'should not be called' }),
    })
    assert.deepEqual(result.segments, [])
    assert.deepEqual(result.trace, [])
  })

  it('single call when all images fit; ceiling not recorded on first-try success', async () => {
    let calls = 0
    const result = await describeImagesAdaptive({
      images: [fakeImage(1), fakeImage(2), fakeImage(3)],
      endpoint: 'e',
      baseUrl: undefined,
      upstreamModel: 'm',
      call: async ({ images }) => {
        calls += 1
        return { text: `described ${images.length} images` }
      },
    })
    assert.equal(calls, 1)
    assert.equal(result.segments.length, 1)
    assert.equal(result.segments[0].pageStart, 1)
    assert.equal(result.segments[0].pageEnd, 3)
    assert.equal(result.segments[0].text, 'described 3 images')
    // First-try success doesn't tell us the actual provider cap (we never
    // tried bigger), so ceiling stays null. Caching N here would cause
    // subsequent N+1 batches to split unnecessarily — see the
    // "preserves order around mixed text + image sequences" test below
    // where two adjacent image groups would otherwise contaminate each
    // other.
    assert.equal(
      readBatchCeiling({ endpoint: 'e', baseUrl: undefined, upstreamModel: 'm', kind: 'image' }),
      null,
    )
  })

  it('halves on size-class error and concatenates per-half segments', async () => {
    // 4 images. First call (full=4) fails; halve to [2, 2]; both succeed.
    // Final result: 2 segments (1-2, 3-4).
    let attemptCount = 0
    const result = await describeImagesAdaptive({
      images: [fakeImage(1), fakeImage(2), fakeImage(3), fakeImage(4)],
      endpoint: 'e',
      baseUrl: undefined,
      upstreamModel: 'm',
      call: async ({ images }) => {
        attemptCount += 1
        if (images.length === 4) {
          throw new BatchTooBigError('too many')
        }
        return { text: `chunk-${images.length}` }
      },
    })
    assert.equal(attemptCount, 3, '1 fail + 2 success')
    assert.equal(result.segments.length, 2)
    assert.deepEqual(
      result.segments.map(s => `${s.pageStart}-${s.pageEnd}`),
      ['1-2', '3-4'],
    )
    assert.ok(result.trace.some(line => /halve/.test(line)))
    assert.equal(
      readBatchCeiling({ endpoint: 'e', baseUrl: undefined, upstreamModel: 'm', kind: 'image' }),
      2,
    )
  })

  it('recursively halves all the way to single images', async () => {
    // 4 images. full=4 fails; [2,2] both fail; [1,1,1,1] all succeed.
    let attemptCount = 0
    const result = await describeImagesAdaptive({
      images: [fakeImage(1), fakeImage(2), fakeImage(3), fakeImage(4)],
      endpoint: 'e',
      baseUrl: undefined,
      upstreamModel: 'm',
      call: async ({ images }) => {
        attemptCount += 1
        if (images.length > 1) {
          throw new BatchTooBigError('still too big')
        }
        return { text: `single` }
      },
    })
    assert.equal(attemptCount, 3 + 4, '1 + 2 fails + 4 successes')
    assert.equal(result.segments.length, 4)
    assert.equal(
      result.segments.every(s => s.pageStart === s.pageEnd),
      true,
    )
    assert.equal(
      readBatchCeiling({ endpoint: 'e', baseUrl: undefined, upstreamModel: 'm', kind: 'image' }),
      1,
    )
  })

  it('marks single-image failure as failed segment without aborting siblings', async () => {
    // 2 images. [2] fails; halve to [1, 1]. Image 1 succeeds, image 2 fails.
    // Result: 2 segments — first ok, second marked failed.
    const result = await describeImagesAdaptive({
      images: [fakeImage(1), fakeImage(2)],
      endpoint: 'e',
      baseUrl: undefined,
      upstreamModel: 'm',
      call: async ({ images }) => {
        if (images.length === 2) throw new BatchTooBigError('full fail')
        if (Buffer.isBuffer(images[0].buffer) && images[0].buffer.toString() === 'image-2') {
          throw new BatchTooBigError('single fail')
        }
        return { text: 'ok' }
      },
    })
    assert.equal(result.segments.length, 2)
    assert.equal(result.segments[0].pageStart, 1)
    assert.equal(result.segments[0].failed, undefined)
    assert.equal(result.segments[1].pageStart, 2)
    assert.equal(result.segments[1].failed, true)
    assert.match(result.segments[1].text, /failed/i)
  })

  it('starts from cached ceiling on subsequent calls', async () => {
    // First call: 4 → halve to [2, 2] → ceiling=2.
    let firstAttempts = 0
    await describeImagesAdaptive({
      images: [fakeImage(1), fakeImage(2), fakeImage(3), fakeImage(4)],
      endpoint: 'e',
      baseUrl: undefined,
      upstreamModel: 'm',
      call: async ({ images }) => {
        firstAttempts += 1
        if (images.length === 4) throw new BatchTooBigError('first')
        return { text: 'ok' }
      },
    })
    assert.equal(firstAttempts, 3)
    assert.equal(
      readBatchCeiling({ endpoint: 'e', baseUrl: undefined, upstreamModel: 'm', kind: 'image' }),
      2,
    )

    // Second call: 4 images, ceiling=2, so split upfront into [2, 2] without
    // failing. 2 calls, no halving.
    let secondAttempts = 0
    const result = await describeImagesAdaptive({
      images: [fakeImage(1), fakeImage(2), fakeImage(3), fakeImage(4)],
      endpoint: 'e',
      baseUrl: undefined,
      upstreamModel: 'm',
      call: async () => {
        secondAttempts += 1
        return { text: 'ok' }
      },
    })
    assert.equal(secondAttempts, 2, 'no halving on cached ceiling')
    assert.equal(result.segments.length, 2)
  })

  it('propagates non-size-class errors transparently', async () => {
    await assert.rejects(
      describeImagesAdaptive({
        images: [fakeImage(1)],
        endpoint: 'e',
        baseUrl: undefined,
        upstreamModel: 'm',
        call: async () => {
          const e = new Error('upstream timeout') as Error & { status: number }
          e.status = 504
          throw e
        },
      }),
      /upstream timeout/,
    )
  })
})

describe('joinSegmentsForLLM', () => {
  it('returns empty string for no segments', () => {
    assert.equal(joinSegmentsForLLM([]), '')
  })

  it('returns the single segment text unchanged', () => {
    assert.equal(
      joinSegmentsForLLM([{ pageStart: 1, pageEnd: 1, text: 'hello' }]),
      'hello',
    )
  })

  it('renders per-segment headers when multiple segments', () => {
    const out = joinSegmentsForLLM([
      { pageStart: 1, pageEnd: 5, text: 'first' },
      { pageStart: 6, pageEnd: 10, text: 'second' },
    ])
    assert.match(out, /\[images 1-5\]/)
    assert.match(out, /\[images 6-10\]/)
    assert.match(out, /first/)
    assert.match(out, /second/)
  })

  it('uses sourceLabel when provided', () => {
    const out = joinSegmentsForLLM(
      [
        { pageStart: 1, pageEnd: 3, text: 'a' },
        { pageStart: 4, pageEnd: 5, text: 'b' },
      ],
      { sourceLabel: 'foo.pdf' },
    )
    assert.match(out, /\[foo\.pdf, images 1-3\]/)
    assert.match(out, /\[foo\.pdf, images 4-5\]/)
  })
})
