import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { ALIAS_TO_MODE, MODE_ALIASES, modeToAlias, parseMode } from './mode-aliases.js'

describe('mode aliases', () => {
  it('parseMode resolves all 4 aliases case-insensitively', () => {
    assert.equal(parseMode('read'), 'plan')
    assert.equal(parseMode('READ'), 'plan')
    assert.equal(parseMode('ask'), 'default')
    assert.equal(parseMode('auto'), 'acceptEdits')
    assert.equal(parseMode('yolo'), 'bypassPermissions')
  })

  it('parseMode also accepts internal enum (back-compat for scripts)', () => {
    assert.equal(parseMode('plan'), 'plan')
    assert.equal(parseMode('default'), 'default')
    assert.equal(parseMode('acceptEdits'), 'acceptEdits')
    assert.equal(parseMode('bypassPermissions'), 'bypassPermissions')
  })

  it('parseMode returns null for unknown / empty', () => {
    assert.equal(parseMode('xxx'), null)
    assert.equal(parseMode(''), null)
    assert.equal(parseMode('  '), null)
  })

  it('modeToAlias maps internal enum back to alias', () => {
    assert.equal(modeToAlias('plan'), 'read')
    assert.equal(modeToAlias('default'), 'ask')
    assert.equal(modeToAlias('acceptEdits'), 'auto')
    assert.equal(modeToAlias('bypassPermissions'), 'yolo')
  })

  it('alias <-> mode round-trip is consistent for every alias', () => {
    for (const alias of MODE_ALIASES) {
      const mode = ALIAS_TO_MODE[alias]!
      assert.equal(modeToAlias(mode), alias)
      assert.equal(parseMode(alias), mode)
    }
  })

  it('parseMode trims whitespace', () => {
    assert.equal(parseMode('  yolo  '), 'bypassPermissions')
    assert.equal(parseMode('\tauto\n'), 'acceptEdits')
  })
})
