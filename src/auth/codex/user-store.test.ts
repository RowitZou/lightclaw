import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
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

import { setLightclawHomeOverride } from '../../paths.js'
import { userStateRoot } from '../../identity/paths.js'
import {
  deleteUserCodexAuth,
  importUserCodexAuth,
  listUserCodexAuth,
  parseCodexAuthRef,
  persistDeviceLoginResult,
  readUserCodexAuth,
  userCodexAuthDir,
  userCodexAuthPath,
} from './user-store.js'
import { decodeExpiresAtMs } from './jwt.js'

// A throwaway JWT-shaped access token whose `exp` claim is far in the future,
// so loadCodexCliTokens derives a non-expired expires_at. base64url, no sig
// verification (we only decode the payload).
function fakeJwt(expSeconds: number, claims: Record<string, unknown> = {}): string {
  const enc = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString('base64url')
  const header = enc({ alg: 'none', typ: 'JWT' })
  const payload = enc({ exp: expSeconds, ...claims })
  return `${header}.${payload}.sig`
}

describe('user codex store (PR5 checkpoint 2)', () => {
  let tmpHome: string

  beforeEach(() => {
    tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-codex-store-test-'))
    setLightclawHomeOverride(tmpHome)
  })

  afterEach(() => {
    setLightclawHomeOverride(undefined)
    rmSync(tmpHome, { recursive: true, force: true })
  })

  it('re-homed path: userCodexAuthDir/Path sit under userStateRoot/auth/codex', () => {
    assert.equal(userCodexAuthDir('alice'), path.join(userStateRoot('alice'), 'auth', 'codex'))
    assert.equal(
      userCodexAuthPath('alice', 'personal'),
      path.join(userStateRoot('alice'), 'auth', 'codex', 'personal.json'),
    )
    // default name.
    assert.equal(
      userCodexAuthPath('alice'),
      path.join(userStateRoot('alice'), 'auth', 'codex', 'default.json'),
    )
  })

  it('parseCodexAuthRef extracts the name, rejects malformed refs', () => {
    assert.equal(parseCodexAuthRef('codex:personal'), 'personal')
    assert.equal(parseCodexAuthRef('  codex:default  '), 'default')
    assert.throws(() => parseCodexAuthRef('personal'))
    assert.throws(() => parseCodexAuthRef('codex:bad/name'))
  })

  it('import from a codex-cli auth.json derives expires_at from the JWT exp and persists into the per-user store', () => {
    const exp = Math.floor(Date.now() / 1000) + 3600
    const access = fakeJwt(exp)
    const cliFile = path.join(tmpHome, 'codex-cli-auth.json')
    writeFileSync(
      cliFile,
      JSON.stringify({
        tokens: {
          access_token: access,
          refresh_token: 'refresh-xyz',
          account_id: 'acct-123',
        },
      }),
    )
    const summary = importUserCodexAuth({ canonicalUser: 'alice', name: 'personal', fromPath: cliFile })
    assert.equal(summary.name, 'personal')
    assert.equal(summary.accountId, 'acct-123')
    // expires_at derived from the JWT exp claim (the CLI file has no explicit one).
    assert.equal(summary.expiresAt, decodeExpiresAtMs(access))

    // Persisted into the re-homed per-user store, NOT the global codex.json.
    const stored = readUserCodexAuth('alice', 'personal')
    assert.ok(stored)
    assert.equal(stored!.tokens.access_token, access)
    assert.equal(stored!.tokens.refresh_token, 'refresh-xyz')
    assert.equal(stored!.account_id, 'acct-123')
    assert.ok(existsSync(userCodexAuthPath('alice', 'personal')))
  })

  it('persistDeviceLoginResult lands the same store shape as import (expiry + account_id from JWT, device-login source)', () => {
    const exp = Math.floor(Date.now() / 1000) + 3600
    const access = fakeJwt(exp, { 'https://api.openai.com/auth': { account_id: 'acct-dev' } })
    const summary = persistDeviceLoginResult({
      canonicalUser: 'alice',
      name: 'personal',
      tokens: { idToken: 'id.jwt.sig', accessToken: access, refreshToken: 'refresh-dev' },
    })
    // account_id decoded from the JWT (the exchange response carries none).
    assert.equal(summary.accountId, 'acct-dev')
    // expires_at derived from the JWT exp claim, same as the import path.
    assert.equal(summary.expiresAt, decodeExpiresAtMs(access))
    assert.equal(summary.source, 'codex-device-login')

    // Persisted into the per-user store, readable by the SAME read path as import.
    const stored = readUserCodexAuth('alice', 'personal')
    assert.ok(stored)
    assert.equal(stored!.tokens.access_token, access)
    assert.equal(stored!.tokens.refresh_token, 'refresh-dev')
    assert.equal(stored!.tokens.id_token, 'id.jwt.sig')
    assert.equal(stored!.tokens.expires_at, decodeExpiresAtMs(access))
    assert.equal(stored!.account_id, 'acct-dev')
    assert.equal(stored!.source, 'codex-device-login')
    assert.ok(existsSync(userCodexAuthPath('alice', 'personal')))
  })

  it('persistDeviceLoginResult rejects an access_token whose expiry cannot be decoded', () => {
    assert.throws(() =>
      persistDeviceLoginResult({
        canonicalUser: 'alice',
        name: 'personal',
        tokens: { accessToken: 'not-a-jwt', refreshToken: 'r' },
      }),
    )
  })

  it('list reflects imported entries; remove deletes only the named entry', () => {
    const exp = Math.floor(Date.now() / 1000) + 3600
    const cliFile = path.join(tmpHome, 'cli.json')
    writeFileSync(
      cliFile,
      JSON.stringify({ tokens: { access_token: fakeJwt(exp), refresh_token: 'r', account_id: 'a' } }),
    )
    importUserCodexAuth({ canonicalUser: 'alice', name: 'one', fromPath: cliFile })
    importUserCodexAuth({ canonicalUser: 'alice', name: 'two', fromPath: cliFile })
    assert.deepEqual(listUserCodexAuth('alice').map(e => e.name), ['one', 'two'])

    assert.equal(deleteUserCodexAuth('alice', 'one'), true)
    assert.deepEqual(listUserCodexAuth('alice').map(e => e.name), ['two'])
    // Removing a non-existent name is a graceful false.
    assert.equal(deleteUserCodexAuth('alice', 'ghost'), false)
  })

  it('per-user isolation: alice and bob never share a codex store', () => {
    const exp = Math.floor(Date.now() / 1000) + 3600
    const cliFile = path.join(tmpHome, 'cli.json')
    writeFileSync(
      cliFile,
      JSON.stringify({ tokens: { access_token: fakeJwt(exp), refresh_token: 'r', account_id: 'a' } }),
    )
    importUserCodexAuth({ canonicalUser: 'alice', name: 'personal', fromPath: cliFile })
    assert.equal(readUserCodexAuth('bob', 'personal'), null)
    assert.deepEqual(listUserCodexAuth('bob'), [])
  })

  it('imported tokens land 0600 with a 0700 dir', () => {
    if (process.platform === 'win32') return
    const exp = Math.floor(Date.now() / 1000) + 3600
    const cliFile = path.join(tmpHome, 'cli.json')
    writeFileSync(
      cliFile,
      JSON.stringify({ tokens: { access_token: fakeJwt(exp), refresh_token: 'r', account_id: 'a' } }),
    )
    importUserCodexAuth({ canonicalUser: 'alice', name: 'personal', fromPath: cliFile })
    const fileMode = statSync(userCodexAuthPath('alice', 'personal')).mode & 0o777
    const dirMode = statSync(userCodexAuthDir('alice')).mode & 0o777
    assert.equal(fileMode, 0o600)
    assert.equal(dirMode, 0o700)
  })

  it('on-disk store never round-trips a malformed shape past validation', () => {
    const file = userCodexAuthPath('alice', 'broken')
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ tokens: { access_token: 'x' } }))
    assert.throws(() => readUserCodexAuth('alice', 'broken'))
    // The valid file we wrote is unaffected — sanity check read path.
    assert.equal(readFileSync(file, 'utf8').includes('access_token'), true)
  })
})
