import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

import { AuthError } from './types.js'
import { readTokenFile, writeTokenFile } from './storage.js'
import { setLightclawHomeOverride } from '../paths.js'
import { decodeAccountId, extractAccountIdFromTokens } from './codex/jwt.js'
import { createCodexAuthProvider, type HttpFn } from './codex/provider.js'

let tmpHome: string
let tmpCodexHome: string
let savedCodexHome: string | undefined

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-codex-test-home-'))
  tmpCodexHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-codex-test-cli-'))
  setLightclawHomeOverride(tmpHome)
  savedCodexHome = process.env.CODEX_HOME
  process.env.CODEX_HOME = tmpCodexHome
})

afterEach(() => {
  setLightclawHomeOverride(undefined)
  rmSync(tmpHome, { recursive: true, force: true })
  rmSync(tmpCodexHome, { recursive: true, force: true })
  if (savedCodexHome === undefined) {
    delete process.env.CODEX_HOME
  } else {
    process.env.CODEX_HOME = savedCodexHome
  }
})

function makeJwt(payload: object): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
    .toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  // Signature is irrelevant — we only base64-decode the payload.
  return `${header}.${body}.signature`
}

function writeCliAuth(body: object): void {
  writeFileSync(path.join(tmpCodexHome, 'auth.json'), JSON.stringify(body))
}

describe('codex/jwt', () => {
  it('decodes account_id from a valid JWT payload', () => {
    const jwt = makeJwt({
      sub: 'user-1',
      'https://api.openai.com/auth': { account_id: 'acc-abc-123' },
    })
    assert.equal(decodeAccountId(jwt), 'acc-abc-123')
  })

  it('returns null on a non-JWT string', () => {
    assert.equal(decodeAccountId('not.a.jwt.with.too.many.parts'), null)
    assert.equal(decodeAccountId('only.one'), null)
    assert.equal(decodeAccountId(''), null)
  })

  it('returns null when the payload is base64 garbage', () => {
    assert.equal(decodeAccountId('aaa.@@notbase64@@.bbb'), null)
  })

  it('returns null when the auth claim is missing', () => {
    const jwt = makeJwt({ sub: 'user-1' })
    assert.equal(decodeAccountId(jwt), null)
  })

  it('extractAccountIdFromTokens prefers id_token over access_token', () => {
    const idJwt = makeJwt({
      'https://api.openai.com/auth': { account_id: 'from-id' },
    })
    const accessJwt = makeJwt({
      'https://api.openai.com/auth': { account_id: 'from-access' },
    })
    assert.equal(
      extractAccountIdFromTokens({ id_token: idJwt, access_token: accessJwt }),
      'from-id',
    )
  })

  it('extractAccountIdFromTokens falls back to access_token', () => {
    const accessJwt = makeJwt({
      'https://api.openai.com/auth': { account_id: 'from-access' },
    })
    assert.equal(
      extractAccountIdFromTokens({ access_token: accessJwt }),
      'from-access',
    )
  })

  it('extractAccountIdFromTokens returns empty string when neither has it', () => {
    assert.equal(extractAccountIdFromTokens({}), '')
    assert.equal(extractAccountIdFromTokens({ access_token: 'opaque' }), '')
  })
})

describe('codex provider: import()', () => {
  it('imports a fresh CLI token file', async () => {
    const idJwt = makeJwt({
      'https://api.openai.com/auth': { account_id: 'acc-1' },
    })
    writeCliAuth({
      tokens: {
        id_token: idJwt,
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      },
    })
    const provider = createCodexAuthProvider()
    await provider.import?.()
    const stored = readTokenFile('codex') as Record<string, unknown>
    assert.ok(stored)
    assert.equal((stored.tokens as { access_token: string }).access_token, 'access-1')
    assert.equal(stored.account_id, 'acc-1')
    assert.equal(stored.source, 'codex-cli-import')
  })

  it('rejects when CLI auth file is absent', async () => {
    const provider = createCodexAuthProvider()
    await assert.rejects(() => provider.import?.() as Promise<unknown>, (err: unknown) =>
      err instanceof AuthError && err.code === 'auth_missing',
    )
  })

  it('rejects expired CLI tokens', async () => {
    writeCliAuth({
      tokens: {
        access_token: 'A',
        refresh_token: 'R',
        expires_at: new Date(Date.now() - 60_000).toISOString(),
      },
    })
    const provider = createCodexAuthProvider()
    await assert.rejects(() => provider.import?.() as Promise<unknown>, (err: unknown) =>
      err instanceof AuthError && err.code === 'tokens_expired',
    )
  })

  it('rejects CLI auth file missing required fields', async () => {
    writeCliAuth({ tokens: { access_token: 'A' } })
    const provider = createCodexAuthProvider()
    await assert.rejects(() => provider.import?.() as Promise<unknown>, (err: unknown) =>
      err instanceof AuthError && err.code === 'tokens_invalid_shape',
    )
  })
})

describe('codex provider: getCredentials()', () => {
  it('throws auth_missing when no token file exists', async () => {
    const provider = createCodexAuthProvider()
    await assert.rejects(() => provider.getCredentials(), (err: unknown) =>
      err instanceof AuthError && err.code === 'auth_missing',
    )
  })

  it('returns stored credentials without refresh when not expiring', async () => {
    writeTokenFile('codex', {
      tokens: {
        access_token: 'fresh',
        refresh_token: 'r',
        expires_at: Date.now() + 3600_000,
      },
      account_id: 'acc-1',
      source: 'codex-cli-import',
    })
    let calls = 0
    const http: HttpFn = async () => {
      calls += 1
      return { statusCode: 200, bodyText: '{}' }
    }
    const provider = createCodexAuthProvider({ http })
    const creds = await provider.getCredentials()
    assert.equal(creds.accessToken, 'fresh')
    assert.equal(creds.accountId, 'acc-1')
    assert.equal(calls, 0)
  })

  it('refreshes when token is within the skew window', async () => {
    const idJwt = makeJwt({
      'https://api.openai.com/auth': { account_id: 'acc-after-refresh' },
    })
    writeTokenFile('codex', {
      tokens: {
        access_token: 'old',
        refresh_token: 'r-old',
        expires_at: Date.now() + 30_000, // 30s, below 120s skew
      },
      account_id: 'acc-1',
      source: 'codex-cli-import',
    })
    const http: HttpFn = async () => ({
      statusCode: 200,
      bodyText: JSON.stringify({
        access_token: 'new-access',
        refresh_token: 'r-new',
        id_token: idJwt,
        expires_in: 3600,
        token_type: 'Bearer',
      }),
    })
    const provider = createCodexAuthProvider({ http })
    const creds = await provider.getCredentials()
    assert.equal(creds.accessToken, 'new-access')
    assert.equal(creds.accountId, 'acc-after-refresh')
    const stored = readTokenFile('codex') as Record<string, unknown>
    assert.equal(stored.source, 'lightclaw-refresh')
    assert.ok(stored.last_refresh)
  })

  it('throws refresh_consumed_by_other_client on 401 invalid_grant', async () => {
    writeTokenFile('codex', {
      tokens: {
        access_token: 'old',
        refresh_token: 'r-old',
        expires_at: Date.now() + 30_000,
      },
      account_id: 'acc-1',
      source: 'codex-cli-import',
    })
    const http: HttpFn = async () => ({
      statusCode: 401,
      bodyText: JSON.stringify({
        error: 'invalid_grant',
        error_description: 'refresh_token already consumed',
      }),
    })
    const provider = createCodexAuthProvider({ http })
    await assert.rejects(() => provider.getCredentials(), (err: unknown) =>
      err instanceof AuthError && err.code === 'refresh_consumed_by_other_client',
    )
  })

  it('throws refresh_failed on a 500 server error', async () => {
    writeTokenFile('codex', {
      tokens: {
        access_token: 'old',
        refresh_token: 'r-old',
        expires_at: Date.now() + 30_000,
      },
      account_id: 'acc-1',
      source: 'codex-cli-import',
    })
    const http: HttpFn = async () => ({
      statusCode: 500,
      bodyText: '<html>Server Error</html>',
    })
    const provider = createCodexAuthProvider({ http })
    await assert.rejects(() => provider.getCredentials(), (err: unknown) =>
      err instanceof AuthError && err.code === 'refresh_failed',
    )
  })

  it('throws tokens_invalid_shape when stored file is corrupt', async () => {
    writeTokenFile('codex', { tokens: { access_token: 'A' } })
    const provider = createCodexAuthProvider()
    await assert.rejects(() => provider.getCredentials(), (err: unknown) =>
      err instanceof AuthError && err.code === 'tokens_invalid_shape',
    )
  })
})

describe('codex provider: logout()', () => {
  it('removes the stored file', async () => {
    writeTokenFile('codex', {
      tokens: { access_token: 'A', refresh_token: 'R', expires_at: 0 },
      account_id: '',
      source: 'codex-cli-import',
    })
    const provider = createCodexAuthProvider()
    await provider.logout()
    assert.equal(readTokenFile('codex'), null)
  })

  it('is idempotent on missing file', async () => {
    const provider = createCodexAuthProvider()
    await provider.logout()
    assert.equal(readTokenFile('codex'), null)
  })
})
