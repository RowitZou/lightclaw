import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  DeviceLoginError,
  exchangeAuthCode,
  pollForToken,
  requestUserCode,
  resolveDeviceIssuer,
} from './device-login.js'
import type { HttpFn } from './provider.js'

// A scripted HttpFn: returns the next queued response per call and records the
// requests it saw, so each test asserts on URL / body shape AND drives the
// state machine with a deterministic status sequence.
type Scripted = { statusCode: number; bodyText: string }
function scriptedHttp(responses: Scripted[]): {
  http: HttpFn
  calls: Array<{ url: string; body: string; headers: Record<string, string> }>
} {
  const calls: Array<{ url: string; body: string; headers: Record<string, string> }> = []
  let i = 0
  const http: HttpFn = async input => {
    calls.push(input)
    const res = responses[Math.min(i, responses.length - 1)]
    i += 1
    return res
  }
  return { http, calls }
}

describe('codex device-login pure core (PR1)', () => {
  it('resolveDeviceIssuer trims override and falls back to public issuer', () => {
    assert.equal(resolveDeviceIssuer(undefined), 'https://auth.openai.com')
    assert.equal(resolveDeviceIssuer('   '), 'https://auth.openai.com')
    assert.equal(resolveDeviceIssuer('https://mirror.example.com/'), 'https://mirror.example.com')
  })

  it('requestUserCode parses a 200 usercode payload (interval string → number)', async () => {
    const { http, calls } = scriptedHttp([
      {
        statusCode: 200,
        bodyText: JSON.stringify({
          device_auth_id: 'deviceauth_6a43',
          user_code: 'FEFH-CWVQI',
          interval: '5',
          expires_at: '2026-06-30T04:00:17.517168+00:00',
        }),
      },
    ])
    const res = await requestUserCode(http)
    assert.equal(res.deviceAuthId, 'deviceauth_6a43')
    assert.equal(res.userCode, 'FEFH-CWVQI')
    assert.equal(res.interval, 5)
    assert.equal(res.expiresAtMs, Date.parse('2026-06-30T04:00:17.517168+00:00'))
    // Hits the device usercode endpoint under {issuer}/api/accounts.
    assert.equal(calls[0].url, 'https://auth.openai.com/api/accounts/deviceauth/usercode')
    assert.deepEqual(JSON.parse(calls[0].body), { client_id: 'app_EMoamEEZ73f0CkXaXp7hrann' })
  })

  it('requestUserCode throws DeviceLoginError on a 404 (device login not enabled)', async () => {
    const { http } = scriptedHttp([{ statusCode: 404, bodyText: 'not found' }])
    await assert.rejects(requestUserCode(http), (err: unknown) => {
      assert.ok(err instanceof DeviceLoginError)
      assert.equal(err.reason, 'http')
      assert.equal(err.status, 404)
      return true
    })
  })

  it('requestUserCode throws malformed when device_auth_id is missing', async () => {
    const { http } = scriptedHttp([{ statusCode: 200, bodyText: JSON.stringify({ user_code: 'X' }) }])
    await assert.rejects(requestUserCode(http), (err: unknown) => {
      assert.ok(err instanceof DeviceLoginError)
      assert.equal(err.reason, 'malformed')
      return true
    })
  })

  it('pollForToken retries on 403→404→200 and returns the code + verifier', async () => {
    const { http, calls } = scriptedHttp([
      { statusCode: 403, bodyText: '' },
      { statusCode: 404, bodyText: '' },
      {
        statusCode: 200,
        bodyText: JSON.stringify({
          authorization_code: 'authcode_xyz',
          code_verifier: 'verifier_abc',
          code_challenge: 'challenge_def',
        }),
      },
    ])
    const sleeps: number[] = []
    const res = await pollForToken(http, {
      deviceAuthId: 'deviceauth_6a43',
      userCode: 'FEFH-CWVQI',
      interval: 5,
      now: () => 1000, // never advances → never times out
      sleep: async ms => {
        sleeps.push(ms)
      },
    })
    assert.equal(res.authorizationCode, 'authcode_xyz')
    assert.equal(res.codeVerifier, 'verifier_abc')
    assert.equal(res.codeChallenge, 'challenge_def')
    // Two waits (after the 403 and the 404), each one interval.
    assert.deepEqual(sleeps, [5000, 5000])
    assert.equal(calls[0].url, 'https://auth.openai.com/api/accounts/deviceauth/token')
    assert.deepEqual(JSON.parse(calls[0].body), {
      device_auth_id: 'deviceauth_6a43',
      user_code: 'FEFH-CWVQI',
    })
  })

  it('pollForToken throws reason=timeout when the hard deadline passes', async () => {
    const { http } = scriptedHttp([{ statusCode: 403, bodyText: '' }])
    let clock = 0
    await assert.rejects(
      pollForToken(http, {
        deviceAuthId: 'd',
        userCode: 'c',
        interval: 5,
        maxWaitMs: 1000,
        now: () => {
          // First read (start) = 0; subsequent reads jump past the deadline.
          const t = clock
          clock += 2000
          return t
        },
        sleep: async () => {},
      }),
      (err: unknown) => {
        assert.ok(err instanceof DeviceLoginError)
        assert.equal(err.reason, 'timeout')
        return true
      },
    )
  })

  it('pollForToken throws reason=aborted when the signal is already aborted', async () => {
    const { http } = scriptedHttp([{ statusCode: 403, bodyText: '' }])
    const ac = new AbortController()
    ac.abort()
    await assert.rejects(
      pollForToken(http, { deviceAuthId: 'd', userCode: 'c', interval: 5, signal: ac.signal }),
      (err: unknown) => {
        assert.ok(err instanceof DeviceLoginError)
        assert.equal(err.reason, 'aborted')
        return true
      },
    )
  })

  it('pollForToken throws on an unexpected non-200/403/404 status', async () => {
    const { http } = scriptedHttp([{ statusCode: 500, bodyText: 'server error' }])
    await assert.rejects(
      pollForToken(http, { deviceAuthId: 'd', userCode: 'c', interval: 5, sleep: async () => {} }),
      (err: unknown) => {
        assert.ok(err instanceof DeviceLoginError)
        assert.equal(err.reason, 'http')
        assert.equal(err.status, 500)
        return true
      },
    )
  })

  it('exchangeAuthCode posts form-urlencoded and returns the token triple', async () => {
    const { http, calls } = scriptedHttp([
      {
        statusCode: 200,
        bodyText: JSON.stringify({
          id_token: 'id.jwt.sig',
          access_token: 'access.jwt.sig',
          refresh_token: 'refresh_token_value',
        }),
      },
    ])
    const res = await exchangeAuthCode(http, { code: 'authcode_xyz', codeVerifier: 'verifier_abc' })
    assert.equal(res.accessToken, 'access.jwt.sig')
    assert.equal(res.refreshToken, 'refresh_token_value')
    assert.equal(res.idToken, 'id.jwt.sig')
    assert.equal(calls[0].url, 'https://auth.openai.com/oauth/token')
    assert.equal(calls[0].headers['content-type'], 'application/x-www-form-urlencoded')
    const form = new URLSearchParams(calls[0].body)
    assert.equal(form.get('grant_type'), 'authorization_code')
    assert.equal(form.get('code'), 'authcode_xyz')
    assert.equal(form.get('code_verifier'), 'verifier_abc')
    assert.equal(form.get('client_id'), 'app_EMoamEEZ73f0CkXaXp7hrann')
    assert.equal(form.get('redirect_uri'), 'https://auth.openai.com/deviceauth/callback')
  })

  it('exchangeAuthCode surfaces the error body on a non-200', async () => {
    const { http } = scriptedHttp([
      {
        statusCode: 400,
        bodyText: JSON.stringify({ error: 'invalid_grant', error_description: 'code expired' }),
      },
    ])
    await assert.rejects(
      exchangeAuthCode(http, { code: 'x', codeVerifier: 'y' }),
      (err: unknown) => {
        assert.ok(err instanceof DeviceLoginError)
        assert.equal(err.reason, 'http')
        assert.equal(err.status, 400)
        assert.match(err.message, /invalid_grant/)
        assert.match(err.message, /code expired/)
        return true
      },
    )
  })

  it('exchangeAuthCode honors an issuer override for both endpoint and redirect_uri', async () => {
    const { http, calls } = scriptedHttp([
      {
        statusCode: 200,
        bodyText: JSON.stringify({ access_token: 'a', refresh_token: 'r' }),
      },
    ])
    await exchangeAuthCode(http, {
      code: 'x',
      codeVerifier: 'y',
      issuer: 'https://mirror.example.com',
    })
    assert.equal(calls[0].url, 'https://mirror.example.com/oauth/token')
    const form = new URLSearchParams(calls[0].body)
    assert.equal(form.get('redirect_uri'), 'https://mirror.example.com/deviceauth/callback')
  })
})
