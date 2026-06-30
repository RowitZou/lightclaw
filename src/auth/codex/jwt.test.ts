import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { decodeAccountId, extractAccountIdFromTokens } from './jwt.js'

/** Build a JWT whose payload base64url-encodes `payload`. Only the payload
 *  segment is decoded by `decodeAccountId`; header/signature are placeholders. */
function jwtWith(payload: unknown): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `eyJhbGciOiJub25lIn0.${body}.sig`
}

const AUTH_CLAIM = 'https://api.openai.com/auth'

describe('decodeAccountId', () => {
  it('reads chatgpt_account_id from the auth claim (the live device-login field)', () => {
    // 2026-06-30 dogfood regression: device-login tokens carry the account id
    // under `chatgpt_account_id`, NOT `account_id`. Reading the wrong field
    // returned empty and dropped the required `chatgpt-account-id` header.
    const jwt = jwtWith({ [AUTH_CLAIM]: { chatgpt_account_id: 'acc_workspace_123' } })
    assert.equal(decodeAccountId(jwt), 'acc_workspace_123')
    assert.equal(extractAccountIdFromTokens({ access_token: jwt }), 'acc_workspace_123')
  })

  it('still honors the legacy account_id / accountId field shapes', () => {
    assert.equal(decodeAccountId(jwtWith({ [AUTH_CLAIM]: { account_id: 'acc_legacy' } })), 'acc_legacy')
    assert.equal(decodeAccountId(jwtWith({ [AUTH_CLAIM]: { accountId: 'acc_camel' } })), 'acc_camel')
  })

  it('prefers chatgpt_account_id when multiple fields are present', () => {
    const jwt = jwtWith({ [AUTH_CLAIM]: { chatgpt_account_id: 'acc_primary', account_id: 'acc_legacy' } })
    assert.equal(decodeAccountId(jwt), 'acc_primary')
  })

  it('returns null when the auth claim has no account id', () => {
    assert.equal(decodeAccountId(jwtWith({ [AUTH_CLAIM]: { email: 'x@y.z' } })), null)
    assert.equal(decodeAccountId(jwtWith({ other: 'claim' })), null)
    assert.equal(decodeAccountId('not-a-jwt'), null)
  })

  it('extractAccountIdFromTokens tries id_token before access_token, else empty', () => {
    const idJwt = jwtWith({ [AUTH_CLAIM]: { chatgpt_account_id: 'acc_from_id' } })
    const accessJwt = jwtWith({ [AUTH_CLAIM]: { chatgpt_account_id: 'acc_from_access' } })
    assert.equal(extractAccountIdFromTokens({ id_token: idJwt, access_token: accessJwt }), 'acc_from_id')
    assert.equal(extractAccountIdFromTokens({ access_token: accessJwt }), 'acc_from_access')
    assert.equal(extractAccountIdFromTokens({}), '')
  })
})
