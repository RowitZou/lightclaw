import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { setLightclawHomeOverride } from '../paths.js'
import {
  getUserCodexCredentials,
  importUserCodexAuth,
  listUserCodexAuth,
  readUserCodexAuth,
  userCodexAuthPath,
} from './codex/user-store.js'

let home = ''

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'lightclaw-user-codex-'))
  setLightclawHomeOverride(home)
})

afterEach(() => {
  setLightclawHomeOverride(undefined)
  rmSync(home, { recursive: true, force: true })
})

describe('per-user Codex auth store', () => {
  it('imports a Codex CLI auth file into users/<u>/auth/codex/<name>.json', async () => {
    const source = path.join(home, 'auth.json')
    writeFileSync(source, JSON.stringify({
      tokens: {
        access_token: jwtExpIn(3600, 'acc-from-token'),
        refresh_token: 'refresh-user',
        account_id: 'acc-from-file',
      },
    }))

    const summary = importUserCodexAuth({
      canonicalUser: 'alice',
      name: 'default',
      fromPath: source,
    })
    const stored = readUserCodexAuth('alice', 'default')
    const credentials = await getUserCodexCredentials({ canonicalUser: 'alice', name: 'default' })

    assert.equal(summary.name, 'default')
    assert.equal(summary.accountId, 'acc-from-file')
    assert.equal(stored?.tokens.refresh_token, 'refresh-user')
    assert.equal(credentials.accessToken, stored?.tokens.access_token)
    assert.equal(credentials.accountId, 'acc-from-file')
    assert.match(userCodexAuthPath('alice', 'default'), /users\/alice\/auth\/codex\/default\.json$/)
    assert.deepEqual(listUserCodexAuth('alice').map(item => item.name), ['default'])
  })
})

function makeJwt(payload: object): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.signature`
}

function jwtExpIn(seconds: number, accountId: string): string {
  return makeJwt({
    exp: Math.floor((Date.now() + seconds * 1000) / 1000),
    iat: Math.floor(Date.now() / 1000),
    'https://api.openai.com/auth': { account_id: accountId },
  })
}
