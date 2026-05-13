import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import {
  clearCapability,
  isCapabilityMissingError,
  readCachedCapability,
  recordCapability,
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
  it('returns the declared flag when nothing is cached', () => {
    const flag = readCachedCapability({
      endpoint: 'newapi',
      upstreamModel: 'claude-sonnet-4-6',
      kind: 'image',
      declared: 'unknown',
    })
    assert.equal(flag, 'unknown')
  })

  it('persists a recorded false and overrides the declared flag', () => {
    recordCapability({
      endpoint: 'codex',
      upstreamModel: 'gpt-5.5',
      kind: 'image',
      value: false,
    })
    const flag = readCachedCapability({
      endpoint: 'codex',
      upstreamModel: 'gpt-5.5',
      kind: 'image',
      declared: 'unknown',
    })
    assert.equal(flag, false)
    assert.ok(existsSync(path.join(homeDir, 'auth', 'capabilities-cache.json')))
  })

  it('keys per endpoint × upstreamModel — flips do not bleed across', () => {
    recordCapability({
      endpoint: 'newapi',
      upstreamModel: 'claude-sonnet-4-6',
      kind: 'image',
      value: false,
    })
    const otherEndpoint = readCachedCapability({
      endpoint: 'anthropic-direct',
      upstreamModel: 'claude-sonnet-4-6',
      kind: 'image',
      declared: 'unknown',
    })
    const otherModel = readCachedCapability({
      endpoint: 'newapi',
      upstreamModel: 'claude-haiku-4-5',
      kind: 'image',
      declared: 'unknown',
    })
    assert.equal(otherEndpoint, 'unknown', 'different endpoint unaffected')
    assert.equal(otherModel, 'unknown', 'different model unaffected')
  })

  it('round-trips through disk — second process-equivalent reload reads the verdict', () => {
    recordCapability({
      endpoint: 'codex',
      upstreamModel: 'gpt-5.5',
      kind: 'pdf',
      value: false,
    })
    _resetCacheForTests()  // simulate process restart
    const flag = readCachedCapability({
      endpoint: 'codex',
      upstreamModel: 'gpt-5.5',
      kind: 'pdf',
      declared: 'unknown',
    })
    assert.equal(flag, false)
  })

  it('survives a corrupt cache file', () => {
    const file = path.join(homeDir, 'auth', 'capabilities-cache.json')
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, '{not json', 'utf8')
    _resetCacheForTests()
    const flag = readCachedCapability({
      endpoint: 'x',
      upstreamModel: 'y',
      kind: 'image',
      declared: 'unknown',
    })
    assert.equal(flag, 'unknown', 'corrupt cache → fall back to declared')
  })

  it('writes JSON shape that is human-readable and stable', () => {
    recordCapability({ endpoint: 'a', upstreamModel: 'b', kind: 'image', value: true })
    recordCapability({ endpoint: 'a', upstreamModel: 'b', kind: 'pdf', value: false })
    const raw = readFileSync(path.join(homeDir, 'auth', 'capabilities-cache.json'), 'utf8')
    const parsed = JSON.parse(raw)
    assert.equal(parsed.version, 1)
    assert.deepEqual(parsed.flags['a:b'], { image: true, pdf: false })
  })

  it('clearCapability removes a stale entry and lets declared pass through', () => {
    recordCapability({ endpoint: 'codex', upstreamModel: 'gpt-5.5', kind: 'pdf', value: false })
    const removed = clearCapability({ endpoint: 'codex', upstreamModel: 'gpt-5.5', kind: 'pdf' })
    assert.equal(removed, true)
    const flag = readCachedCapability({
      endpoint: 'codex',
      upstreamModel: 'gpt-5.5',
      kind: 'pdf',
      declared: true,
    })
    assert.equal(flag, true, 'declared:true now passes through after clear')
  })

  it('clearCapability is a no-op on a missing entry', () => {
    const removed = clearCapability({ endpoint: 'codex', upstreamModel: 'gpt-5.5', kind: 'pdf' })
    assert.equal(removed, false)
  })

  it('clearCapability does not disturb sibling kinds or sibling models', () => {
    recordCapability({ endpoint: 'codex', upstreamModel: 'gpt-5.5', kind: 'pdf', value: false })
    recordCapability({ endpoint: 'codex', upstreamModel: 'gpt-5.5', kind: 'audio', value: false })
    recordCapability({ endpoint: 'codex', upstreamModel: 'gpt-5.4-mini', kind: 'pdf', value: false })
    clearCapability({ endpoint: 'codex', upstreamModel: 'gpt-5.5', kind: 'pdf' })
    assert.equal(
      readCachedCapability({ endpoint: 'codex', upstreamModel: 'gpt-5.5', kind: 'audio', declared: false }),
      false,
      'sibling kind on same model untouched',
    )
    assert.equal(
      readCachedCapability({ endpoint: 'codex', upstreamModel: 'gpt-5.4-mini', kind: 'pdf', declared: 'unknown' }),
      false,
      'same kind on sibling model untouched',
    )
  })

  it('clearCapability collapses an empty per-model entry off the JSON', () => {
    recordCapability({ endpoint: 'codex', upstreamModel: 'gpt-5.5', kind: 'pdf', value: false })
    clearCapability({ endpoint: 'codex', upstreamModel: 'gpt-5.5', kind: 'pdf' })
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
