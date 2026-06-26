import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  isReasoningKnownUnsupported,
  markReasoningUnsupported,
  clearReasoningSupport,
  _resetReasoningSupportForTests,
} from './reasoning-support.js'

describe('reasoning-support memo', () => {
  let home: string
  let prevHome: string | undefined

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'lc-reasoning-'))
    prevHome = process.env.LIGHTCLAW_HOME
    process.env.LIGHTCLAW_HOME = home
    _resetReasoningSupportForTests()
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.LIGHTCLAW_HOME
    else process.env.LIGHTCLAW_HOME = prevHome
    _resetReasoningSupportForTests()
    rmSync(home, { recursive: true, force: true })
  })

  it('starts unknown and flips on mark', () => {
    assert.equal(isReasoningKnownUnsupported('http://x', 'm'), false)
    markReasoningUnsupported('http://x', 'm')
    assert.equal(isReasoningKnownUnsupported('http://x', 'm'), true)
  })

  it('persists across a fresh in-process load (survives daemon restart)', () => {
    markReasoningUnsupported('http://x', 'm')
    // Drop the in-process cache so the next read reloads from disk — proves
    // the verdict survives a restart, not just the live Map.
    _resetReasoningSupportForTests()
    assert.equal(isReasoningKnownUnsupported('http://x', 'm'), true)
  })

  it('clear removes the verdict and persists the removal', () => {
    markReasoningUnsupported('http://x', 'm')
    assert.equal(clearReasoningSupport('http://x', 'm'), true)
    assert.equal(isReasoningKnownUnsupported('http://x', 'm'), false)
    _resetReasoningSupportForTests()
    assert.equal(isReasoningKnownUnsupported('http://x', 'm'), false)
    // Clearing an absent entry is a no-op false.
    assert.equal(clearReasoningSupport('http://x', 'm'), false)
  })

  it('keys on (baseUrl, model) — neither axis bleeds into the other', () => {
    markReasoningUnsupported('http://a', 'm1')
    assert.equal(isReasoningKnownUnsupported('http://a', 'm1'), true)
    assert.equal(isReasoningKnownUnsupported('http://b', 'm1'), false) // different baseUrl
    assert.equal(isReasoningKnownUnsupported('http://a', 'm2'), false) // different model
    // undefined baseUrl (default endpoint) is its own stable key.
    markReasoningUnsupported(undefined, 'm1')
    assert.equal(isReasoningKnownUnsupported(undefined, 'm1'), true)
    assert.equal(isReasoningKnownUnsupported('http://a', 'm1'), true)
  })
})
