import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { requireConfirm } from './confirm.js'

describe('requireConfirm', () => {
  it('returns a preview (no action) when --y is absent', () => {
    const gate = requireConfirm(['rm', 'alice'], { preview: 'will remove alice' })
    assert.equal(gate.confirmed, false)
    if (!gate.confirmed) {
      assert.match(gate.message, /will remove alice/)
    }
  })

  it('confirms on --y and strips it from rest', () => {
    const gate = requireConfirm(['rm', 'alice', '--y'], { preview: 'p' })
    assert.equal(gate.confirmed, true)
    if (gate.confirmed) {
      assert.deepEqual(gate.rest, ['rm', 'alice'])
    }
  })

  it('confirms on an IME-mangled em-dash `—y` (Feishu rewrites a typed --)', () => {
    // Feishu / CJK IME smart punctuation rewrites the typed `--y` to `—y`
    // before it reaches the daemon. The gate itself must be dash-robust —
    // callers' parsers may or may not canonicalize, and an unconfirmable
    // destructive command is a user-visible dead loop (preview forever).
    for (const token of ['—y', '–y', '―y']) {
      const gate = requireConfirm(['rm', 'alice', token], { preview: 'p' })
      assert.equal(gate.confirmed, true, `${token} must confirm`)
      if (gate.confirmed) {
        assert.deepEqual(gate.rest, ['rm', 'alice'])
      }
    }
  })

  it('strips only the confirm token — other tokens reach rest verbatim', () => {
    // The gate must never rewrite caller values (a dash-led value could be
    // silently corrupted); only the matched confirm token is removed.
    const gate = requireConfirm(['set', 'NAME', '—weird—value', '—y'], { preview: 'p' })
    assert.equal(gate.confirmed, true)
    if (gate.confirmed) {
      assert.deepEqual(gate.rest, ['set', 'NAME', '—weird—value'])
    }
  })
})
