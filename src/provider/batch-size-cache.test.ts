import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import {
  isBatchTooBigError,
  readBatchCeiling,
  recordBatchCeiling,
  _resetCacheForTests,
} from './batch-size-cache.js'

let prevHome: string | undefined
let homeDir: string

beforeEach(() => {
  homeDir = mkdtempSync(path.join(tmpdir(), 'lightclaw-batch-'))
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

describe('readBatchCeiling / recordBatchCeiling', () => {
  it('returns null when nothing is cached', () => {
    const value = readBatchCeiling({
      endpoint: 'newapi',
      baseUrl: undefined,
      upstreamModel: 'claude-sonnet-4-6',
      kind: 'image',
    })
    assert.equal(value, null)
  })

  it('records and reads back a ceiling', () => {
    recordBatchCeiling({
      endpoint: 'newapi',
      baseUrl: undefined,
      upstreamModel: 'claude-sonnet-4-6',
      kind: 'image',
      size: 5,
    })
    assert.equal(
      readBatchCeiling({
        endpoint: 'newapi',
        baseUrl: undefined,
        upstreamModel: 'claude-sonnet-4-6',
        kind: 'image',
      }),
      5,
    )
  })

  it('keeps separate ceilings per endpoint × upstreamModel × kind', () => {
    recordBatchCeiling({
      endpoint: 'a',
      baseUrl: undefined,
      upstreamModel: 'm',
      kind: 'image',
      size: 10,
    })
    recordBatchCeiling({
      endpoint: 'b',
      baseUrl: undefined,
      upstreamModel: 'm',
      kind: 'image',
      size: 3,
    })
    recordBatchCeiling({
      endpoint: 'a',
      baseUrl: undefined,
      upstreamModel: 'm',
      kind: 'pdf',
      size: 7,
    })
    assert.equal(readBatchCeiling({ endpoint: 'a', baseUrl: undefined, upstreamModel: 'm', kind: 'image' }), 10)
    assert.equal(readBatchCeiling({ endpoint: 'b', baseUrl: undefined, upstreamModel: 'm', kind: 'image' }), 3)
    assert.equal(readBatchCeiling({ endpoint: 'a', baseUrl: undefined, upstreamModel: 'm', kind: 'pdf' }), 7)
  })

  it('keeps separate ceilings per baseUrl — repointing the same alias yields a fresh row', () => {
    recordBatchCeiling({
      endpoint: 'newapi',
      baseUrl: 'https://oldgw.example.com',
      upstreamModel: 'm',
      kind: 'image',
      size: 5,
    })
    const repointed = readBatchCeiling({
      endpoint: 'newapi',
      baseUrl: 'https://api.openai.com',
      upstreamModel: 'm',
      kind: 'image',
    })
    assert.equal(repointed, null, 'new baseUrl gets a fresh ceiling slot')
  })

  it('only updates monotonically — smaller sizes do not overwrite larger', () => {
    recordBatchCeiling({
      endpoint: 'e',
      baseUrl: undefined,
      upstreamModel: 'm',
      kind: 'image',
      size: 12,
    })
    recordBatchCeiling({
      endpoint: 'e',
      baseUrl: undefined,
      upstreamModel: 'm',
      kind: 'image',
      size: 4,
    })
    assert.equal(readBatchCeiling({ endpoint: 'e', baseUrl: undefined, upstreamModel: 'm', kind: 'image' }), 12)
  })

  it('ignores non-positive / non-finite sizes', () => {
    recordBatchCeiling({ endpoint: 'e', baseUrl: undefined, upstreamModel: 'm', kind: 'image', size: 0 })
    recordBatchCeiling({ endpoint: 'e', baseUrl: undefined, upstreamModel: 'm', kind: 'image', size: -3 })
    recordBatchCeiling({ endpoint: 'e', baseUrl: undefined, upstreamModel: 'm', kind: 'image', size: NaN })
    assert.equal(readBatchCeiling({ endpoint: 'e', baseUrl: undefined, upstreamModel: 'm', kind: 'image' }), null)
  })

  it('drops legacy keys (old `${alias}:${model}` shape) on load', () => {
    const file = path.join(homeDir, 'auth', 'batch-size-cache.json')
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({
      version: 1,
      ceilings: {
        'newapi:m': { image: 8 },
      },
    }), 'utf8')
    _resetCacheForTests()
    const value = readBatchCeiling({
      endpoint: 'newapi',
      baseUrl: undefined,
      upstreamModel: 'm',
      kind: 'image',
    })
    assert.equal(value, null, 'legacy ceiling dropped on load')
  })
})

describe('isBatchTooBigError', () => {
  it('returns true for 413 payload too large', () => {
    assert.equal(isBatchTooBigError({ status: 413 }), true)
    assert.equal(
      isBatchTooBigError({ status: 413, message: 'Payload Too Large' }),
      true,
    )
  })

  it('returns true for 400 with size-class signals', () => {
    assert.equal(
      isBatchTooBigError({ status: 400, message: 'too many images supplied' }),
      true,
    )
    assert.equal(
      isBatchTooBigError({ status: 400, message: 'context_length_exceeded' }),
      true,
    )
    assert.equal(
      isBatchTooBigError({ status: 400, message: 'prompt_too_long: 250000 tokens' }),
      true,
    )
    assert.equal(
      isBatchTooBigError({ status: 400, message: 'image_count_exceeded' }),
      true,
    )
  })

  it('returns true for 422 with size-class signals', () => {
    assert.equal(
      isBatchTooBigError({ status: 422, message: 'input.too.large' }),
      true,
    )
  })

  it('returns false for transient / unrelated errors', () => {
    assert.equal(isBatchTooBigError({ status: 429 }), false)
    assert.equal(isBatchTooBigError({ status: 500 }), false)
    assert.equal(isBatchTooBigError({ status: 401 }), false)
    assert.equal(
      isBatchTooBigError({ status: 400, message: 'invalid api key' }),
      false,
    )
    assert.equal(isBatchTooBigError(null), false)
    assert.equal(isBatchTooBigError(undefined), false)
    assert.equal(isBatchTooBigError('string error'), false)
  })
})
