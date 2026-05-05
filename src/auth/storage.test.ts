import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

import {
  _authDirForTests,
  _tokenFilePathForTests,
  deleteTokenFile,
  readTokenFile,
  writeTokenFile,
} from './storage.js'
import {
  AuthError,
  _resetAuthProviderRegistryForTests,
  getAuthProvider,
  registerAuthProvider,
} from './index.js'
import { setLightclawHomeOverride } from '../paths.js'

let tmpHome: string

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-auth-test-'))
  setLightclawHomeOverride(tmpHome)
  _resetAuthProviderRegistryForTests()
})

afterEach(() => {
  setLightclawHomeOverride(undefined)
  rmSync(tmpHome, { recursive: true, force: true })
})

describe('auth/storage', () => {
  it('returns null when token file is missing', () => {
    assert.equal(readTokenFile('codex'), null)
  })

  it('round-trips JSON via writeTokenFile -> readTokenFile', () => {
    const payload = {
      tokens: { access_token: 'A', refresh_token: 'R', expires_at: 999 },
      account_id: 'acc-1',
      source: 'codex-cli-import',
    }
    writeTokenFile('codex', payload)
    const read = readTokenFile('codex')
    assert.deepEqual(read, payload)
  })

  it('creates the auth dir on first write with mode 0700', () => {
    assert.equal(existsSync(_authDirForTests()), false)
    writeTokenFile('codex', { tokens: { access_token: 'A' } })
    assert.equal(existsSync(_authDirForTests()), true)
    if (process.platform !== 'win32') {
      const mode = statSync(_authDirForTests()).mode & 0o777
      assert.equal(mode, 0o700)
    }
  })

  it('writes the token file with mode 0600', () => {
    writeTokenFile('codex', { tokens: { access_token: 'A' } })
    if (process.platform !== 'win32') {
      const mode = statSync(_tokenFilePathForTests('codex')).mode & 0o777
      assert.equal(mode, 0o600)
    }
  })

  it('deleteTokenFile removes the file and is idempotent on missing', () => {
    writeTokenFile('codex', { tokens: { access_token: 'A' } })
    assert.equal(existsSync(_tokenFilePathForTests('codex')), true)
    deleteTokenFile('codex')
    assert.equal(existsSync(_tokenFilePathForTests('codex')), false)
    // Calling again must not throw.
    deleteTokenFile('codex')
  })

  it('overwrites an existing token file atomically', () => {
    writeTokenFile('codex', { tokens: { access_token: 'OLD' } })
    writeTokenFile('codex', { tokens: { access_token: 'NEW' } })
    const read = readTokenFile('codex') as {
      tokens: { access_token: string }
    }
    assert.equal(read.tokens.access_token, 'NEW')
  })

  it('throws on a corrupt JSON token file', () => {
    // Write a non-JSON body directly to bypass writeTokenFile validation.
    mkdirSync(_authDirForTests(), { recursive: true, mode: 0o700 })
    writeFileSync(_tokenFilePathForTests('codex'), 'not-json{', {
      mode: 0o600,
    })
    assert.throws(() => readTokenFile('codex'))
  })

  it('readTokenFile is provider-scoped (codex vs other)', () => {
    writeTokenFile('codex', { tokens: { access_token: 'CODEX' } })
    writeTokenFile('other', { tokens: { access_token: 'OTHER' } })
    const a = readTokenFile('codex') as { tokens: { access_token: string } }
    const b = readTokenFile('other') as { tokens: { access_token: string } }
    assert.equal(a.tokens.access_token, 'CODEX')
    assert.equal(b.tokens.access_token, 'OTHER')
    // confirm files exist on disk (cross-check sanity)
    const _ = readFileSync(_tokenFilePathForTests('codex'), 'utf8')
    assert.match(_, /CODEX/)
  })
})

describe('auth/index registry', () => {
  it('throws AuthError(unknown_provider) for unregistered names', () => {
    assert.throws(
      () => getAuthProvider('phantom'),
      (err: unknown) =>
        err instanceof AuthError &&
        err.code === 'unknown_provider' &&
        err.provider === 'phantom',
    )
  })

  it('register + getAuthProvider round-trip', async () => {
    const fake = {
      name: 'fake',
      async getCredentials() {
        return { accessToken: 'A', expiresAt: 0, accountId: 'X' }
      },
      async logout() {},
    }
    registerAuthProvider(fake)
    const got = getAuthProvider('fake')
    assert.equal(got, fake)
    const creds = await got.getCredentials()
    assert.equal(creds.accessToken, 'A')
  })
})
