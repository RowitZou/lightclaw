import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import {
  clearAllForModel,
  clearCacheEntry,
  incrementFailureCounter,
  isCapabilityMissingError,
  readCacheEntry,
  resetAllFailureCountersFor,
  writeCacheEntry,
  _resetCacheForTests,
} from './capability-cache.js'

let prevHome: string | undefined
let homeDir: string

beforeEach(() => {
  homeDir = mkdtempSync(path.join(tmpdir(), 'lightclaw-cap-'))
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

describe('capability-cache', () => {
  it('returns null when nothing is cached for a kind × position', () => {
    const entry = readCacheEntry({
      endpoint: 'newapi',
      upstreamModel: 'claude-sonnet-4-6',
      kind: 'image',
      position: 'inUserMessage',
    })
    assert.equal(entry, null)
  })

  it('persists a cache entry for one kind × position', () => {
    writeCacheEntry({
      endpoint: 'codex',
      upstreamModel: 'gpt-5.5',
      kind: 'image',
      position: 'inToolResult',
      entry: { enabled: false, failures: 2 },
    })
    const entry = readCacheEntry({
      endpoint: 'codex',
      upstreamModel: 'gpt-5.5',
      kind: 'image',
      position: 'inToolResult',
    })
    assert.deepEqual(entry, { enabled: false, failures: 2 })
    assert.ok(existsSync(path.join(homeDir, 'auth', 'capabilities-cache.json')))
  })

  it('keys per endpoint × upstreamModel — flips do not bleed across', () => {
    writeCacheEntry({
      endpoint: 'newapi',
      upstreamModel: 'claude-sonnet-4-6',
      kind: 'image',
      position: 'inUserMessage',
      entry: { enabled: false, failures: 0 },
    })
    const otherEndpoint = readCacheEntry({
      endpoint: 'anthropic-direct',
      upstreamModel: 'claude-sonnet-4-6',
      kind: 'image',
      position: 'inUserMessage',
    })
    const otherModel = readCacheEntry({
      endpoint: 'newapi',
      upstreamModel: 'claude-haiku-4-5',
      kind: 'image',
      position: 'inUserMessage',
    })
    assert.equal(otherEndpoint, null, 'different endpoint unaffected')
    assert.equal(otherModel, null, 'different model unaffected')
  })

  it('round-trips through disk — second process-equivalent reload reads the verdict', () => {
    writeCacheEntry({
      endpoint: 'codex',
      upstreamModel: 'gpt-5.5',
      kind: 'pdf',
      position: 'inUserMessage',
      entry: { enabled: false, failures: 1 },
    })
    _resetCacheForTests()  // simulate process restart
    const entry = readCacheEntry({
      endpoint: 'codex',
      upstreamModel: 'gpt-5.5',
      kind: 'pdf',
      position: 'inUserMessage',
    })
    assert.deepEqual(entry, { enabled: false, failures: 1 })
  })

  it('survives a corrupt cache file', () => {
    const file = path.join(homeDir, 'auth', 'capabilities-cache.json')
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, '{not json', 'utf8')
    _resetCacheForTests()
    const entry = readCacheEntry({
      endpoint: 'x',
      upstreamModel: 'y',
      kind: 'image',
      position: 'inUserMessage',
    })
    assert.equal(entry, null, 'corrupt cache -> empty cache')
  })

  it('writes JSON shape that is human-readable and stable', () => {
    writeCacheEntry({
      endpoint: 'a',
      upstreamModel: 'b',
      kind: 'image',
      position: 'inUserMessage',
      entry: { enabled: true, failures: 0 },
    })
    writeCacheEntry({
      endpoint: 'a',
      upstreamModel: 'b',
      kind: 'pdf',
      position: 'inToolResult',
      entry: { enabled: false, failures: 5 },
    })
    const raw = readFileSync(path.join(homeDir, 'auth', 'capabilities-cache.json'), 'utf8')
    const parsed = JSON.parse(raw)
    assert.equal(parsed.version, 2)
    assert.deepEqual(parsed.flags['a:b'], {
      image: { inUserMessage: { enabled: true, failures: 0 } },
      pdf: { inToolResult: { enabled: false, failures: 5 } },
    })
  })

  it('migrates v1 flags to v2 inUserMessage entries', () => {
    const file = path.join(homeDir, 'auth', 'capabilities-cache.json')
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({
      version: 1,
      flags: {
        'codex:gpt-5.5': { pdf: false, image: true },
      },
    }), 'utf8')
    _resetCacheForTests()
    assert.deepEqual(
      readCacheEntry({
        endpoint: 'codex',
        upstreamModel: 'gpt-5.5',
        kind: 'pdf',
        position: 'inUserMessage',
      }),
      { enabled: false, failures: 0 },
    )
    assert.equal(
      readCacheEntry({
        endpoint: 'codex',
        upstreamModel: 'gpt-5.5',
        kind: 'pdf',
        position: 'inToolResult',
      }),
      null,
      'v1 had no tool_result dimension',
    )
  })

  it('clearCacheEntry removes one position and leaves siblings', () => {
    writeCacheEntry({
      endpoint: 'codex',
      upstreamModel: 'gpt-5.5',
      kind: 'pdf',
      position: 'inUserMessage',
      entry: { enabled: false, failures: 0 },
    })
    writeCacheEntry({
      endpoint: 'codex',
      upstreamModel: 'gpt-5.5',
      kind: 'pdf',
      position: 'inToolResult',
      entry: { enabled: true, failures: 0 },
    })
    const removed = clearCacheEntry({
      endpoint: 'codex',
      upstreamModel: 'gpt-5.5',
      kind: 'pdf',
      position: 'inUserMessage',
    })
    assert.equal(removed, true)
    assert.equal(readCacheEntry({
      endpoint: 'codex',
      upstreamModel: 'gpt-5.5',
      kind: 'pdf',
      position: 'inUserMessage',
    }), null)
    assert.deepEqual(readCacheEntry({
      endpoint: 'codex',
      upstreamModel: 'gpt-5.5',
      kind: 'pdf',
      position: 'inToolResult',
    }), { enabled: true, failures: 0 })
  })

  it('clearCacheEntry is a no-op on a missing entry', () => {
    const removed = clearCacheEntry({
      endpoint: 'codex',
      upstreamModel: 'gpt-5.5',
      kind: 'pdf',
      position: 'inUserMessage',
    })
    assert.equal(removed, false)
  })

  it('incrementFailureCounter flips enabled=false on the fifth failure', () => {
    const key = {
      endpoint: 'e',
      upstreamModel: 'm',
      kind: 'image' as const,
      position: 'inToolResult' as const,
    }
    for (let i = 1; i <= 4; i += 1) {
      const result = incrementFailureCounter(key)
      assert.deepEqual(result, { newFailures: i, flippedToDisabled: false })
      assert.equal(readCacheEntry(key)?.enabled, true)
    }
    const fifth = incrementFailureCounter(key)
    assert.deepEqual(fifth, { newFailures: 5, flippedToDisabled: true })
    assert.deepEqual(readCacheEntry(key), { enabled: false, failures: 5 })
  })

  it('resetAllFailureCountersFor clears failures across one model', () => {
    writeCacheEntry({
      endpoint: 'e',
      upstreamModel: 'm',
      kind: 'image',
      position: 'inUserMessage',
      entry: { enabled: true, failures: 3 },
    })
    writeCacheEntry({
      endpoint: 'e',
      upstreamModel: 'other',
      kind: 'image',
      position: 'inUserMessage',
      entry: { enabled: true, failures: 3 },
    })
    resetAllFailureCountersFor({ endpoint: 'e', upstreamModel: 'm' })
    assert.equal(readCacheEntry({
      endpoint: 'e',
      upstreamModel: 'm',
      kind: 'image',
      position: 'inUserMessage',
    })?.failures, 0)
    assert.equal(readCacheEntry({
      endpoint: 'e',
      upstreamModel: 'other',
      kind: 'image',
      position: 'inUserMessage',
    })?.failures, 3)
  })

  it('clearAllForModel removes one model entry', () => {
    writeCacheEntry({
      endpoint: 'codex',
      upstreamModel: 'gpt-5.5',
      kind: 'pdf',
      position: 'inUserMessage',
      entry: { enabled: false, failures: 0 },
    })
    const removed = clearAllForModel({ endpoint: 'codex', upstreamModel: 'gpt-5.5' })
    assert.equal(removed, true)
    const raw = readFileSync(path.join(homeDir, 'auth', 'capabilities-cache.json'), 'utf8')
    const parsed = JSON.parse(raw)
    assert.equal(parsed.flags['codex:gpt-5.5'], undefined, 'last kind cleared → drop the model key entirely')
  })
})

describe('isCapabilityMissingError', () => {
  it('returns null for non-error inputs', () => {
    assert.equal(isCapabilityMissingError(null), null)
    assert.equal(isCapabilityMissingError(undefined), null)
    assert.equal(isCapabilityMissingError('plain string'), null)
  })

  it('returns null for transport / auth / quota errors', () => {
    assert.equal(isCapabilityMissingError({ status: 401, message: 'unauthorized' }), null)
    assert.equal(isCapabilityMissingError({ status: 429, message: 'rate_limit' }), null)
    assert.equal(isCapabilityMissingError({ status: 502, message: 'bad gateway' }), null)
    assert.equal(isCapabilityMissingError({ message: 'ECONNRESET' }), null)
  })

  it('detects image rejection on 400 + image/vision/multimodal hint', () => {
    assert.equal(
      isCapabilityMissingError({ status: 400, message: 'image_url not supported on this model' }),
      'image',
    )
    assert.equal(
      isCapabilityMissingError({ status: 400, message: 'multimodal input rejected' }),
      'image',
    )
    assert.equal(
      isCapabilityMissingError({ status: 422, message: 'vision is not enabled' }),
      'image',
    )
  })

  it('detects pdf rejection separately from image', () => {
    assert.equal(
      isCapabilityMissingError({ status: 400, message: 'document blocks not supported' }),
      'pdf',
    )
    assert.equal(
      isCapabilityMissingError({ status: 400, message: 'pdf input not allowed' }),
      'pdf',
    )
  })

  it('returns null on ambiguous "unsupported content" without kind hint', () => {
    assert.equal(
      isCapabilityMissingError({ status: 400, message: 'invalid_request_error: unsupported content' }),
      null,
    )
  })
})
