import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { setLightclawHomeOverride } from '../paths.js'
import { identityPermissionsPath } from '../identity/paths.js'
import {
  appendIdentityRules,
  clearIdentityRules,
  loadIdentityRules,
  removeIdentityRule,
} from './storage.js'
import type { PermissionRule } from './types.js'

describe('identity-rule storage', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'lightclaw-perm-store-'))
    setLightclawHomeOverride(home)
  })

  afterEach(() => {
    setLightclawHomeOverride(undefined)
    rmSync(home, { recursive: true, force: true })
  })

  function rule(behavior: PermissionRule['behavior'], text: string): PermissionRule {
    const [toolName, content] = text.split('(')
    return {
      source: 'identity',
      behavior,
      value: {
        toolName,
        ruleContent: content ? content.replace(/\)$/, '') : undefined,
      },
    }
  }

  it('returns [] when no identity file exists for the user', () => {
    assert.deepEqual(loadIdentityRules('alice'), [])
    assert.deepEqual(loadIdentityRules(undefined), [])
  })

  it('appends and reads back allow / deny / ask rules per behavior bucket', () => {
    appendIdentityRules({
      canonicalUser: 'alice',
      rules: [
        rule('allow', 'Bash(curl:*)'),
        rule('deny', 'Bash(rm:*)'),
        rule('ask', 'Bash(sudo:*)'),
      ],
    })
    const reloaded = loadIdentityRules('alice')
    const flat = reloaded.map(r => `${r.behavior}:${r.value.toolName}(${r.value.ruleContent ?? ''})`)
    assert.deepEqual(flat.sort(), [
      'allow:Bash(curl:*)',
      'ask:Bash(sudo:*)',
      'deny:Bash(rm:*)',
    ])
  })

  it('dedups identical entries within the same behavior bucket', () => {
    appendIdentityRules({
      canonicalUser: 'alice',
      rules: [rule('allow', 'Bash(curl:*)'), rule('allow', 'Bash(curl:*)')],
    })
    appendIdentityRules({
      canonicalUser: 'alice',
      rules: [rule('allow', 'Bash(curl:*)')],
    })
    const reloaded = loadIdentityRules('alice')
    assert.equal(reloaded.length, 1, 'duplicates collapse on disk')
  })

  it('isolates rules per canonical user', () => {
    appendIdentityRules({ canonicalUser: 'alice', rules: [rule('allow', 'Bash(curl:*)')] })
    appendIdentityRules({ canonicalUser: 'bob', rules: [rule('allow', 'Bash(rm:*)')] })
    const aliceTexts = loadIdentityRules('alice').map(r => r.value.toolName)
    const bobTexts = loadIdentityRules('bob').map(r => r.value.ruleContent)
    assert.deepEqual(aliceTexts, ['Bash'])
    assert.deepEqual(bobTexts, ['rm:*'])
    // Files should be in separate per-user directories.
    assert.notEqual(
      identityPermissionsPath('alice'),
      identityPermissionsPath('bob'),
    )
  })

  it('writes the file atomically (no .tmp left behind on success)', () => {
    appendIdentityRules({ canonicalUser: 'alice', rules: [rule('allow', 'Bash')] })
    const dir = path.dirname(identityPermissionsPath('alice'))
    const stragglers = readdirSync(dir).filter(name => name.endsWith('.tmp'))
    assert.equal(stragglers.length, 0)
  })

  it('throws when canonicalUser is missing (terminal sessions cannot persist)', () => {
    assert.throws(
      () => appendIdentityRules({
        canonicalUser: '',
        rules: [rule('allow', 'Bash')],
      }),
      /canonicalUser is required/,
    )
  })

  it('removeIdentityRule deletes only the matching entry', () => {
    appendIdentityRules({
      canonicalUser: 'alice',
      rules: [rule('allow', 'Bash(curl:*)'), rule('allow', 'Bash(rm:*)')],
    })
    removeIdentityRule({
      canonicalUser: 'alice',
      rule: rule('allow', 'Bash(curl:*)'),
    })
    const reloaded = loadIdentityRules('alice').map(r => r.value.ruleContent)
    assert.deepEqual(reloaded, ['rm:*'])
  })

  it('removeIdentityRule is no-op when rule absent / file missing', () => {
    // file missing
    removeIdentityRule({
      canonicalUser: 'alice',
      rule: rule('allow', 'Bash'),
    })
    appendIdentityRules({ canonicalUser: 'alice', rules: [rule('allow', 'Bash(rm:*)')] })
    // rule absent
    removeIdentityRule({
      canonicalUser: 'alice',
      rule: rule('allow', 'Bash(curl:*)'),
    })
    const reloaded = loadIdentityRules('alice')
    assert.equal(reloaded.length, 1)
  })

  it('clearIdentityRules empties the file', () => {
    appendIdentityRules({
      canonicalUser: 'alice',
      rules: [rule('allow', 'Bash'), rule('deny', 'Bash(rm:*)')],
    })
    clearIdentityRules('alice')
    const filePath = identityPermissionsPath('alice')
    assert.equal(existsSync(filePath), true, 'file remains as `{}`')
    assert.equal(readFileSync(filePath, 'utf8').trim(), '{}')
    assert.deepEqual(loadIdentityRules('alice'), [])
  })

  it('loadIdentityRules ignores corrupt JSON instead of throwing', () => {
    appendIdentityRules({ canonicalUser: 'alice', rules: [rule('allow', 'Bash')] })
    writeFileSync(identityPermissionsPath('alice'), 'not json at all')
    assert.deepEqual(loadIdentityRules('alice'), [])
  })
})
