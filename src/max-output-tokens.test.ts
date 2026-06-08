import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { resolveWireMaxTokens } from './api.js'

// Pins the wire `max_tokens` precedence that replaced the hardcoded 8192
// provider fallback. The main agent loop passes no explicit value, so it must
// land on the per-model ceiling or the global default; sub-LLM callers
// (compact / recall / session-memory) pass explicit small caps that must win.
describe('resolveWireMaxTokens precedence', () => {
  const config = { maxOutputTokens: 64000 }

  it('caller-explicit value wins over per-model and global', () => {
    assert.equal(
      resolveWireMaxTokens(4096, { maxOutputTokens: 128000 }, config),
      4096,
    )
  })

  it('per-model ceiling applies when no explicit value (e.g. Opus 128K)', () => {
    assert.equal(
      resolveWireMaxTokens(undefined, { maxOutputTokens: 128000 }, config),
      128000,
    )
  })

  it('falls back to the global default when neither is set (main loop)', () => {
    assert.equal(resolveWireMaxTokens(undefined, {}, config), 64000)
  })
})
