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
  scanMessagesForKindPositions,
  writeCacheEntry,
  _internalForTests,
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
      baseUrl: undefined,
      upstreamModel: 'claude-sonnet-4-6',
      kind: 'image',
      position: 'inUserMessage',
    })
    assert.equal(entry, null)
  })

  it('persists a cache entry for one kind × position', () => {
    writeCacheEntry({
      endpoint: 'codex',
      baseUrl: undefined,
      upstreamModel: 'gpt-5.5',
      kind: 'image',
      position: 'inToolResult',
      entry: { enabled: false, failures: 2 },
    })
    const entry = readCacheEntry({
      endpoint: 'codex',
      baseUrl: undefined,
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
      baseUrl: undefined,
      upstreamModel: 'claude-sonnet-4-6',
      kind: 'image',
      position: 'inUserMessage',
      entry: { enabled: false, failures: 0 },
    })
    const otherEndpoint = readCacheEntry({
      endpoint: 'anthropic-direct',
      baseUrl: undefined,
      upstreamModel: 'claude-sonnet-4-6',
      kind: 'image',
      position: 'inUserMessage',
    })
    const otherModel = readCacheEntry({
      endpoint: 'newapi',
      baseUrl: undefined,
      upstreamModel: 'claude-haiku-4-5',
      kind: 'image',
      position: 'inUserMessage',
    })
    assert.equal(otherEndpoint, null, 'different endpoint unaffected')
    assert.equal(otherModel, null, 'different model unaffected')
  })

  it('keys per baseUrl — repointing the same alias yields a fresh entry', () => {
    // The core fix: admin flips `newapi`'s baseUrl from a non-vision gateway
    // to OpenAI direct. The old `enabled:false` row must NOT silently shadow
    // the new endpoint's lookup; same alias + new baseUrl = new key.
    writeCacheEntry({
      endpoint: 'newapi',
      baseUrl: 'https://oldgw.example.com',
      upstreamModel: 'claude-sonnet-4-6',
      kind: 'image',
      position: 'inUserMessage',
      entry: { enabled: false, failures: 0 },
    })
    const repointed = readCacheEntry({
      endpoint: 'newapi',
      baseUrl: 'https://api.anthropic.com',
      upstreamModel: 'claude-sonnet-4-6',
      kind: 'image',
      position: 'inUserMessage',
    })
    assert.equal(repointed, null, 'new baseUrl gets a fresh cache slot')

    const original = readCacheEntry({
      endpoint: 'newapi',
      baseUrl: 'https://oldgw.example.com',
      upstreamModel: 'claude-sonnet-4-6',
      kind: 'image',
      position: 'inUserMessage',
    })
    assert.deepEqual(original, { enabled: false, failures: 0 }, 'old baseUrl entry still readable by same baseUrl')
  })

  it('round-trips through disk — second process-equivalent reload reads the verdict', () => {
    writeCacheEntry({
      endpoint: 'codex',
      baseUrl: 'https://chatgpt.com/backend-api',
      upstreamModel: 'gpt-5.5',
      kind: 'pdf',
      position: 'inUserMessage',
      entry: { enabled: false, failures: 1 },
    })
    _resetCacheForTests()  // simulate process restart
    const entry = readCacheEntry({
      endpoint: 'codex',
      baseUrl: 'https://chatgpt.com/backend-api',
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
      baseUrl: undefined,
      upstreamModel: 'y',
      kind: 'image',
      position: 'inUserMessage',
    })
    assert.equal(entry, null, 'corrupt cache -> empty cache')
  })

  it('writes JSON shape that is human-readable and stable', () => {
    writeCacheEntry({
      endpoint: 'a',
      baseUrl: undefined,
      upstreamModel: 'b',
      kind: 'image',
      position: 'inUserMessage',
      entry: { enabled: true, failures: 0 },
    })
    writeCacheEntry({
      endpoint: 'a',
      baseUrl: undefined,
      upstreamModel: 'b',
      kind: 'pdf',
      position: 'inToolResult',
      entry: { enabled: false, failures: 5 },
    })
    const raw = readFileSync(path.join(homeDir, 'auth', 'capabilities-cache.json'), 'utf8')
    const parsed = JSON.parse(raw)
    assert.equal(parsed.version, 2)
    const fp = _internalForTests.endpointFingerprint(undefined)
    assert.deepEqual(parsed.flags[`a|${fp}|b`], {
      image: { inUserMessage: { enabled: true, failures: 0 } },
      pdf: { inToolResult: { enabled: false, failures: 5 } },
    })
  })

  it('drops v1 flags entirely (no fingerprint available for migration)', () => {
    // v1 keys are `${alias}:${model}` with no baseUrl — there is no safe
    // way to bridge them into the new key shape, so the load path drops
    // them and lets precharge re-fill on the next provider lookup.
    const file = path.join(homeDir, 'auth', 'capabilities-cache.json')
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({
      version: 1,
      flags: {
        'codex:gpt-5.5': { pdf: false, image: true },
      },
    }), 'utf8')
    _resetCacheForTests()
    assert.equal(
      readCacheEntry({
        endpoint: 'codex',
        baseUrl: undefined,
        upstreamModel: 'gpt-5.5',
        kind: 'pdf',
        position: 'inUserMessage',
      }),
      null,
      'v1 migrations drop on load — precharge will re-fill',
    )
  })

  it('drops legacy v2 keys (old alias:model shape) on load', () => {
    // Pre-baseUrl-fix v2 files used `${alias}:${model}` keys. After the
    // key shape change those rows can never hit the new key(), so the
    // load path drops them to keep capabilities-cache.json tidy.
    const file = path.join(homeDir, 'auth', 'capabilities-cache.json')
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({
      version: 2,
      flags: {
        'newapi:claude-sonnet-4-6': {
          image: { inUserMessage: { enabled: false, failures: 0 } },
        },
      },
    }), 'utf8')
    _resetCacheForTests()
    const entry = readCacheEntry({
      endpoint: 'newapi',
      baseUrl: undefined,
      upstreamModel: 'claude-sonnet-4-6',
      kind: 'image',
      position: 'inUserMessage',
    })
    assert.equal(entry, null, 'legacy key dropped on load')
  })

  it('clearCacheEntry removes one position and leaves siblings', () => {
    writeCacheEntry({
      endpoint: 'codex',
      baseUrl: undefined,
      upstreamModel: 'gpt-5.5',
      kind: 'pdf',
      position: 'inUserMessage',
      entry: { enabled: false, failures: 0 },
    })
    writeCacheEntry({
      endpoint: 'codex',
      baseUrl: undefined,
      upstreamModel: 'gpt-5.5',
      kind: 'pdf',
      position: 'inToolResult',
      entry: { enabled: true, failures: 0 },
    })
    const removed = clearCacheEntry({
      endpoint: 'codex',
      baseUrl: undefined,
      upstreamModel: 'gpt-5.5',
      kind: 'pdf',
      position: 'inUserMessage',
    })
    assert.equal(removed, true)
    assert.equal(readCacheEntry({
      endpoint: 'codex',
      baseUrl: undefined,
      upstreamModel: 'gpt-5.5',
      kind: 'pdf',
      position: 'inUserMessage',
    }), null)
    assert.deepEqual(readCacheEntry({
      endpoint: 'codex',
      baseUrl: undefined,
      upstreamModel: 'gpt-5.5',
      kind: 'pdf',
      position: 'inToolResult',
    }), { enabled: true, failures: 0 })
  })

  it('clearCacheEntry is a no-op on a missing entry', () => {
    const removed = clearCacheEntry({
      endpoint: 'codex',
      baseUrl: undefined,
      upstreamModel: 'gpt-5.5',
      kind: 'pdf',
      position: 'inUserMessage',
    })
    assert.equal(removed, false)
  })

  it('incrementFailureCounter flips enabled=false on the fifth failure', () => {
    const key = {
      endpoint: 'e',
      baseUrl: undefined,
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
      baseUrl: undefined,
      upstreamModel: 'm',
      kind: 'image',
      position: 'inUserMessage',
      entry: { enabled: true, failures: 3 },
    })
    writeCacheEntry({
      endpoint: 'e',
      baseUrl: undefined,
      upstreamModel: 'other',
      kind: 'image',
      position: 'inUserMessage',
      entry: { enabled: true, failures: 3 },
    })
    resetAllFailureCountersFor({ endpoint: 'e', baseUrl: undefined, upstreamModel: 'm' })
    assert.equal(readCacheEntry({
      endpoint: 'e',
      baseUrl: undefined,
      upstreamModel: 'm',
      kind: 'image',
      position: 'inUserMessage',
    })?.failures, 0)
    assert.equal(readCacheEntry({
      endpoint: 'e',
      baseUrl: undefined,
      upstreamModel: 'other',
      kind: 'image',
      position: 'inUserMessage',
    })?.failures, 3)
  })

  it('clearAllForModel removes one model entry', () => {
    writeCacheEntry({
      endpoint: 'codex',
      baseUrl: undefined,
      upstreamModel: 'gpt-5.5',
      kind: 'pdf',
      position: 'inUserMessage',
      entry: { enabled: false, failures: 0 },
    })
    const removed = clearAllForModel({ endpoint: 'codex', baseUrl: undefined, upstreamModel: 'gpt-5.5' })
    assert.equal(removed, true)
    const raw = readFileSync(path.join(homeDir, 'auth', 'capabilities-cache.json'), 'utf8')
    const parsed = JSON.parse(raw)
    const fp = _internalForTests.endpointFingerprint(undefined)
    assert.equal(parsed.flags[`codex|${fp}|gpt-5.5`], undefined, 'last kind cleared → drop the model key entirely')
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
    assert.deepEqual(
      isCapabilityMissingError({ status: 400, message: 'image_url not supported on this model' }),
      { kind: 'image', positions: ['inUserMessage', 'inToolResult'] },
    )
    assert.deepEqual(
      isCapabilityMissingError({ status: 400, message: 'multimodal input rejected' }),
      { kind: 'image', positions: ['inUserMessage', 'inToolResult'] },
    )
    assert.deepEqual(
      isCapabilityMissingError(
        { status: 422, message: 'vision is not enabled' },
        { positions: ['inToolResult'] },
      ),
      { kind: 'image', positions: ['inToolResult'] },
    )
  })

  it('detects pdf rejection separately from image', () => {
    assert.deepEqual(
      isCapabilityMissingError({ status: 400, message: 'document blocks not supported' }),
      { kind: 'pdf', positions: ['inUserMessage', 'inToolResult'] },
    )
    assert.deepEqual(
      isCapabilityMissingError({ status: 400, message: 'pdf input not allowed' }),
      { kind: 'pdf', positions: ['inUserMessage', 'inToolResult'] },
    )
  })

  it('attributes positions via scanMessagesForKindPositions when messages provided', () => {
    // user-message top-level has document → inUserMessage attributed
    const inUserOnly = isCapabilityMissingError(
      { status: 400, message: 'pdf input not allowed' },
      {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'document', source: { type: 'base64', mediaType: 'application/pdf', data: 'AA' } },
            ],
          },
        ],
      },
    )
    assert.deepEqual(inUserOnly, { kind: 'pdf', positions: ['inUserMessage'] })

    // tool_result content has document → inToolResult attributed (regression
    // guard for plan-v2 §A fix: was hardcoded inUserMessage)
    const inToolResultOnly = isCapabilityMissingError(
      { status: 400, message: 'document blocks rejected' },
      {
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 't1',
                content: [
                  { type: 'document', source: { type: 'base64', mediaType: 'application/pdf', data: 'AA' } },
                ],
              },
            ],
          },
        ],
      },
    )
    assert.deepEqual(inToolResultOnly, { kind: 'pdf', positions: ['inToolResult'] })

    // both positions carry the same kind → both attributed
    const both = isCapabilityMissingError(
      { status: 400, message: 'pdf not supported' },
      {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'document', source: { type: 'base64', mediaType: 'application/pdf', data: 'AA' } },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 't1',
                content: [
                  { type: 'document', source: { type: 'base64', mediaType: 'application/pdf', data: 'BB' } },
                ],
              },
            ],
          },
        ],
      },
    )
    assert.deepEqual(both, { kind: 'pdf', positions: ['inUserMessage', 'inToolResult'] })
  })

  it('falls back to legacy positions[] override when scan finds nothing', () => {
    // Scan would return [] (no document block anywhere); legacy positions
    // override kicks in.
    const result = isCapabilityMissingError(
      { status: 400, message: 'pdf input not allowed' },
      {
        messages: [{ role: 'user', content: 'plain text only' }],
        positions: ['inUserMessage'],
      },
    )
    assert.deepEqual(result, { kind: 'pdf', positions: ['inUserMessage'] })
  })

  it('scanMessagesForKindPositions handles strings, arrays, mixed shapes', () => {
    assert.deepEqual(
      scanMessagesForKindPositions([{ role: 'user', content: 'string content' }], 'pdf'),
      [],
    )
    assert.deepEqual(
      scanMessagesForKindPositions(
        [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'hello' },
              { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'AA' } },
            ],
          },
        ],
        'image',
      ),
      ['inUserMessage'],
    )
    assert.deepEqual(
      scanMessagesForKindPositions(
        [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 't1',
                content: [
                  { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'AA' } },
                ],
              },
            ],
          },
        ],
        'image',
      ),
      ['inToolResult'],
    )
  })

  it('returns null on ambiguous "unsupported content" without kind hint', () => {
    assert.equal(
      isCapabilityMissingError({ status: 400, message: 'invalid_request_error: unsupported content' }),
      null,
    )
  })
})
