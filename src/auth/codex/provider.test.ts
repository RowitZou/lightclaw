import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { refreshCodexTokens } from './provider.js'
import type { HttpFn } from './provider.js'

function httpReturning(statusCode: number, bodyText: string): HttpFn {
  return async () => ({ statusCode, bodyText })
}

// 2026-07-10 review §1.10: auth.openai.com returned an OBJECT in the OAuth
// error body's `error` field; the diagnostic template coerced it to
// `error=[object Object]`, dropping the upstream error code from the one line
// the admin gets for a credential outage.
describe('codex refresh error diagnostics serialization', () => {
  it('serializes an object-shaped `error` as JSON instead of [object Object] (401 path)', async () => {
    const http = httpReturning(
      401,
      JSON.stringify({ error: { code: 'refresh_consumed_by_other_client', message: 'rotated' } }),
    )
    await assert.rejects(
      () => refreshCodexTokens(http, 'rt-test'),
      (err: Error) => {
        assert.ok(!err.message.includes('[object Object]'), `coerced object leaked: ${err.message}`)
        assert.ok(
          err.message.includes('refresh_consumed_by_other_client'),
          `upstream code missing from diagnostic: ${err.message}`,
        )
        return true
      },
    )
  })

  it('keeps the plain-string `error` path byte-identical', async () => {
    const http = httpReturning(401, JSON.stringify({ error: 'invalid_grant' }))
    await assert.rejects(
      () => refreshCodexTokens(http, 'rt-test'),
      (err: Error) => {
        assert.ok(err.message.includes('error=invalid_grant'), err.message)
        return true
      },
    )
  })

  it('classifies an object body carrying invalid_grant as consumed even on non-401 status', async () => {
    const http = httpReturning(
      400,
      JSON.stringify({ error: { type: 'oauth_error', code: 'invalid_grant' } }),
    )
    await assert.rejects(
      () => refreshCodexTokens(http, 'rt-test'),
      (err: Error & { code?: string }) => {
        assert.equal(err.code, 'refresh_consumed_by_other_client')
        return true
      },
    )
  })

  it('serializes an object-shaped error_description on the generic failure path', async () => {
    const http = httpReturning(
      429,
      JSON.stringify({ error: 'rate_limited', error_description: { retry_after: 30 } }),
    )
    await assert.rejects(
      () => refreshCodexTokens(http, 'rt-test'),
      (err: Error) => {
        assert.ok(!err.message.includes('[object Object]'), err.message)
        assert.ok(err.message.includes('"retry_after":30'), err.message)
        return true
      },
    )
  })
})
