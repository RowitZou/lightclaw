import assert from 'node:assert/strict'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { userSecretsPath } from '../identity/paths.js'
import { setLightclawHomeOverride } from '../paths.js'
import {
  listUserSecretMetadata,
  loadEnabledSecrets,
  loadUserSecrets,
  maskSecret,
  removeUserSecret,
  setEnabled,
  setUserSecret,
  validateSecretName,
} from './store.js'

describe('user secret store', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'lightclaw-secrets-'))
    setLightclawHomeOverride(home)
  })

  afterEach(() => {
    setLightclawHomeOverride(undefined)
    rmSync(home, { recursive: true, force: true })
  })

  it('sets and loads a new secret with metadata', () => {
    const result = setUserSecret('alice', 'GH_TOKEN', 'ghp_abcdef1234567890')

    assert.equal(result.name, 'GH_TOKEN')
    assert.equal(result.replaced, false)
    assert.equal(result.metadata.enabled, false)
    assert.equal(result.metadata.length, 'ghp_abcdef1234567890'.length)
    assert.match(result.metadata.updatedAt, /^\d{4}-\d{2}-\d{2}T/)

    const reloaded = loadUserSecrets('alice')
    assert.equal(reloaded.GH_TOKEN.value, 'ghp_abcdef1234567890')
    assert.equal(reloaded.GH_TOKEN.enabled, false)
    assert.match(reloaded.GH_TOKEN.updatedAt, /^\d{4}-\d{2}-\d{2}T/)
  })

  it('replaces an existing secret while preserving its enabled flag', () => {
    setUserSecret('alice', 'GH_TOKEN', 'old')
    setEnabled('alice', 'GH_TOKEN', true)

    const result = setUserSecret('alice', 'GH_TOKEN', 'new-value')

    assert.equal(result.replaced, true)
    const reloaded = loadUserSecrets('alice')
    assert.equal(reloaded.GH_TOKEN.value, 'new-value')
    assert.equal(reloaded.GH_TOKEN.enabled, true)
  })

  it('writes secrets.json with 0o600 mode and per-user parent with 0o700 mode', () => {
    setUserSecret('alice', 'GH_TOKEN', 'value')

    const fileMode = statSync(userSecretsPath('alice')).mode & 0o777
    const parentMode = statSync(path.dirname(userSecretsPath('alice'))).mode & 0o777
    assert.equal(fileMode, 0o600)
    assert.equal(parentMode, 0o700)
  })

  it('flips enabled state without changing value or updatedAt', () => {
    setUserSecret('alice', 'GH_TOKEN', 'value')
    const before = loadUserSecrets('alice').GH_TOKEN.updatedAt

    assert.deepEqual(setEnabled('alice', 'GH_TOKEN', true), {
      name: 'GH_TOKEN',
      stored: true,
      enabled: true,
    })
    assert.equal(loadEnabledSecrets('alice').get('GH_TOKEN'), 'value')
    assert.equal(loadUserSecrets('alice').GH_TOKEN.updatedAt, before)

    setEnabled('alice', 'GH_TOKEN', false)
    assert.equal(loadEnabledSecrets('alice').has('GH_TOKEN'), false)
    assert.equal(loadUserSecrets('alice').GH_TOKEN.value, 'value')
    assert.equal(loadUserSecrets('alice').GH_TOKEN.updatedAt, before)
  })

  it('returns stored=false when toggling a missing secret', () => {
    assert.deepEqual(setEnabled('alice', 'MISSING', true), {
      name: 'MISSING',
      stored: false,
      enabled: false,
    })
  })

  it('removes a stored secret and is no-op for a missing one', () => {
    setUserSecret('alice', 'GH_TOKEN', 'value')
    setEnabled('alice', 'GH_TOKEN', true)

    assert.deepEqual(removeUserSecret('alice', 'GH_TOKEN'), {
      name: 'GH_TOKEN',
      removed: true,
    })
    assert.equal(loadUserSecrets('alice').GH_TOKEN, undefined)
    assert.equal(loadEnabledSecrets('alice').has('GH_TOKEN'), false)
    assert.deepEqual(removeUserSecret('alice', 'GH_TOKEN'), {
      name: 'GH_TOKEN',
      removed: false,
    })
  })

  it('lists metadata sorted by name and never includes values', () => {
    setUserSecret('alice', 'HF_TOKEN', 'hf_secret_value')
    setUserSecret('alice', 'GH_TOKEN', 'ghp_secret_value')
    setEnabled('alice', 'HF_TOKEN', true)

    const listed = listUserSecretMetadata('alice')
    assert.deepEqual(listed.map(item => item.name), ['GH_TOKEN', 'HF_TOKEN'])
    assert.deepEqual(listed.map(item => item.masked), ['********alue', '********alue'])
    assert.equal(JSON.stringify(listed).includes('ghp_secret_value'), false)
    assert.equal(JSON.stringify(listed).includes('hf_secret_value'), false)
  })

  it('returns enabled secrets sorted by name', () => {
    setUserSecret('alice', 'Z_TOKEN', 'z')
    setUserSecret('alice', 'A_TOKEN', 'a')
    setUserSecret('alice', 'M_TOKEN', 'm')
    setEnabled('alice', 'Z_TOKEN', true)
    setEnabled('alice', 'A_TOKEN', true)

    assert.deepEqual([...loadEnabledSecrets('alice').entries()], [
      ['A_TOKEN', 'a'],
      ['Z_TOKEN', 'z'],
    ])
  })

  it('returns an empty map when the user has no secrets file', () => {
    assert.deepEqual([...loadEnabledSecrets('alice').entries()], [])
  })

  it('rejects invalid and reserved names', () => {
    const badNames = [
      'github_token',
      'BAD-NAME',
      '1A',
      'A.B',
      'A/B',
      '../X',
      `${'A'.repeat(65)}`,
      '',
      'HAS SPACE',
      'PATH',
      'HOME',
      'USER',
      'LIGHTCLAW_HOME',
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'NO_PROXY',
    ]

    for (const badName of badNames) {
      assert.throws(() => validateSecretName(badName), /secret name/)
      assert.throws(() => setUserSecret('alice', badName, 'value'), /secret name/)
    }
  })

  it('rejects NUL bytes but accepts shell-significant characters', () => {
    assert.throws(() => setUserSecret('alice', 'GH_TOKEN', 'bad\0value'), /NUL/)
    const value = 'has spaces "$quotes" and $dollars and `ticks`'
    setUserSecret('alice', 'GH_TOKEN', value)
    assert.equal(loadUserSecrets('alice').GH_TOKEN.value, value)
  })

  it('survives same-key concurrent writers without partial JSON or tmp leftovers', async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        Promise.resolve().then(() => setUserSecret('alice', 'GH_TOKEN', `v${i}`)),
      ),
    )

    const file = userSecretsPath('alice')
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      secrets: { GH_TOKEN: { value: string } }
    }
    assert.match(parsed.secrets.GH_TOKEN.value, /^v\d$/)
    const stragglers = readdirSync(path.dirname(file)).filter(name => name.endsWith('.tmp'))
    assert.deepEqual(stragglers, [])
  })

  it('ignores corrupt or malformed files on load', () => {
    setUserSecret('alice', 'GH_TOKEN', 'value')
    writeFileSync(userSecretsPath('alice'), 'not json')
    assert.deepEqual(loadUserSecrets('alice'), {})

    writeFileSync(userSecretsPath('alice'), JSON.stringify({ version: 1, secrets: [] }))
    assert.deepEqual(loadUserSecrets('alice'), {})
  })

  it('ignores malformed individual entries', () => {
    setUserSecret('alice', 'GOOD', 'value')
    writeFileSync(
      userSecretsPath('alice'),
      JSON.stringify({
        version: 1,
        secrets: {
          GOOD: { value: 'value', enabled: true, updatedAt: 'now' },
          bad: { value: 'skip' },
          NO_VALUE: { enabled: true },
        },
      }),
    )

    assert.deepEqual(Object.keys(loadUserSecrets('alice')), ['GOOD'])
    assert.deepEqual([...loadEnabledSecrets('alice').entries()], [['GOOD', 'value']])
  })

  it('masks short and long values', () => {
    assert.equal(maskSecret('ghp_abcdef1234567890'), '********7890')
    assert.equal(maskSecret('abc'), '****')
    assert.equal(maskSecret('1234'), '****')
  })

  it('does not create a file for missing-user reads', () => {
    assert.deepEqual(loadUserSecrets('alice'), {})
    assert.equal(existsSync(userSecretsPath('alice')), false)
  })
})
