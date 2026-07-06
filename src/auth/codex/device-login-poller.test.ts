import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { DeviceLoginError } from './device-login.js'
import {
  abortAllDeviceLogins,
  inFlightDeviceLoginCount,
  startDeviceLogin,
} from './device-login-poller.js'
import type { HttpFn } from './provider.js'

function fakeJwt(expSeconds: number, claims: Record<string, unknown> = {}): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${enc({ alg: 'none' })}.${enc({ exp: expSeconds, ...claims })}.sig`
}

// URL-routing stub: usercode / token (queue) / oauth-token each get their own
// scripted response, so a multi-iteration poll loop drives deterministically.
function routedHttp(routes: {
  usercode: { statusCode: number; bodyText: string }
  token: Array<{ statusCode: number; bodyText: string }>
  exchange?: { statusCode: number; bodyText: string }
}): HttpFn {
  let tokenI = 0
  return async ({ url }) => {
    if (url.endsWith('/deviceauth/usercode')) return routes.usercode
    if (url.endsWith('/deviceauth/token')) {
      const r = routes.token[Math.min(tokenI, routes.token.length - 1)]
      tokenI += 1
      return r
    }
    if (url.endsWith('/oauth/token')) return routes.exchange!
    throw new Error(`unexpected url ${url}`)
  }
}

function deferred<T = void>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>(r => {
    resolve = r
  })
  return { promise, resolve }
}

const USERCODE_OK = {
  statusCode: 200,
  bodyText: JSON.stringify({
    device_auth_id: 'd1',
    user_code: 'FEFH-CWVQI',
    interval: '1',
    expires_at: '2099-01-01T00:00:00Z',
  }),
}

describe('codex device-login poller (PR3)', () => {
  afterEach(() => {
    abortAllDeviceLogins()
  })

  it('pending → success persists and fires onSuccess exactly once', async () => {
    const onSuccess = deferred<{ accountId: string }>()
    const persisted: string[] = []
    const http = routedHttp({
      usercode: USERCODE_OK,
      token: [{ statusCode: 200, bodyText: JSON.stringify({ authorization_code: 'ac', code_verifier: 'cv' }) }],
      exchange: {
        statusCode: 200,
        bodyText: JSON.stringify({
          access_token: fakeJwt(4102444800, { 'https://api.openai.com/auth': { account_id: 'acct-1' } }),
          refresh_token: 'r1',
        }),
      },
    })
    let failed = false
    const res = await startDeviceLogin({
      canonicalUser: 'alice',
      http,
      sleep: async () => {},
      persist: tokens => {
        persisted.push(tokens.refreshToken)
        return { accountId: 'acct-1' }
      },
      handlers: {
        onStarted: () => {},
        onSuccess: info => onSuccess.resolve(info),
        onExpired: () => {},
        onFailed: () => {
          failed = true
        },
      },
    })
    assert.deepEqual(res, { ok: true })
    const info = await onSuccess.promise
    assert.equal(info.accountId, 'acct-1')
    assert.deepEqual(persisted, ['r1'])
    assert.equal(failed, false)
    await new Promise(r => setImmediate(r))
    assert.equal(inFlightDeviceLoginCount(), 0)
  })

  it('pending → 15-min timeout fires onExpired (not onFailed)', async () => {
    const onExpired = deferred()
    let clock = -500
    const http = routedHttp({
      usercode: USERCODE_OK,
      token: [{ statusCode: 403, bodyText: '' }],
    })
    let failed = false
    await startDeviceLogin({
      canonicalUser: 'alice',
      http,
      maxWaitMs: 1000,
      now: () => {
        clock += 500
        return clock
      },
      sleep: async () => {},
      persist: () => ({ accountId: 'x' }),
      handlers: {
        onStarted: () => {},
        onSuccess: () => {},
        onExpired: () => onExpired.resolve(),
        onFailed: () => {
          failed = true
        },
      },
    })
    await onExpired.promise
    assert.equal(failed, false)
    await new Promise(r => setImmediate(r))
    assert.equal(inFlightDeviceLoginCount(), 0)
  })

  it('an http failure mid-poll fires onFailed', async () => {
    const onFailed = deferred<string>()
    const http = routedHttp({
      usercode: USERCODE_OK,
      token: [{ statusCode: 500, bodyText: 'boom' }],
    })
    await startDeviceLogin({
      canonicalUser: 'alice',
      http,
      sleep: async () => {},
      persist: () => ({ accountId: 'x' }),
      handlers: {
        onStarted: () => {},
        onSuccess: () => {},
        onExpired: () => {},
        onFailed: reason => onFailed.resolve(reason),
      },
    })
    const reason = await onFailed.promise
    assert.match(reason, /500/)
    await new Promise(r => setImmediate(r))
    assert.equal(inFlightDeviceLoginCount(), 0)
  })

  it('a second login for the same user aborts the first (single-flight) — old one fires no terminal handler', async () => {
    // Login A parks in sleep (token always pending) until aborted.
    const abortSleep = (_ms: number, signal?: AbortSignal) =>
      new Promise<void>((_resolve, reject) => {
        signal?.addEventListener(
          'abort',
          () => reject(new DeviceLoginError({ reason: 'aborted', message: 'aborted' })),
          { once: true },
        )
      })
    let aTerminal = false
    await startDeviceLogin({
      canonicalUser: 'alice',
      http: routedHttp({ usercode: USERCODE_OK, token: [{ statusCode: 403, bodyText: '' }] }),
      sleep: abortSleep,
      persist: () => ({ accountId: 'a' }),
      handlers: {
        onStarted: () => {},
        onSuccess: () => {
          aTerminal = true
        },
        onExpired: () => {
          aTerminal = true
        },
        onFailed: () => {
          aTerminal = true
        },
      },
    })
    assert.equal(inFlightDeviceLoginCount(), 1)

    // Login B (same user) succeeds; starting it must abort A.
    const onSuccessB = deferred()
    await startDeviceLogin({
      canonicalUser: 'alice',
      http: routedHttp({
        usercode: USERCODE_OK,
        token: [{ statusCode: 200, bodyText: JSON.stringify({ authorization_code: 'ac', code_verifier: 'cv' }) }],
        exchange: { statusCode: 200, bodyText: JSON.stringify({ access_token: fakeJwt(4102444800), refresh_token: 'r' }) },
      }),
      sleep: async () => {},
      persist: () => ({ accountId: 'b' }),
      handlers: {
        onStarted: () => {},
        onSuccess: () => onSuccessB.resolve(),
        onExpired: () => {},
        onFailed: () => {},
      },
    })
    await onSuccessB.promise
    // Give A's aborted rejection a microtask to unwind.
    await new Promise(r => setImmediate(r))
    assert.equal(aTerminal, false, 'aborted login A must not fire any terminal handler')
    assert.equal(inFlightDeviceLoginCount(), 0)
  })

  it('startDeviceLogin returns ok:false when the usercode request itself fails', async () => {
    const res = await startDeviceLogin({
      canonicalUser: 'alice',
      http: routedHttp({ usercode: { statusCode: 404, bodyText: 'nope' }, token: [] }),
      persist: () => ({ accountId: 'x' }),
      handlers: { onStarted: () => {}, onSuccess: () => {}, onExpired: () => {}, onFailed: () => {} },
    })
    assert.equal(res.ok, false)
    assert.equal(inFlightDeviceLoginCount(), 0)
  })

  // ── §3.6 regressions (2026-07-06): abort / registration ordering ──────────

  const EXCHANGE_OK = {
    statusCode: 200,
    bodyText: JSON.stringify({ access_token: fakeJwt(4102444800), refresh_token: 'r' }),
  }
  const TOKEN_200 = {
    statusCode: 200,
    bodyText: JSON.stringify({ authorization_code: 'ac', code_verifier: 'cv' }),
  }

  // Regression (§3.6a): the single-flight slot must be claimed BEFORE the step-1
  // await. Pre-fix, two near-simultaneous starts both read `prior === undefined`,
  // neither aborted the other, and the overwritten first entry's controller was
  // unreachable forever — two detached poll loops ran side by side.
  it('two near-simultaneous starts: the first is superseded even while both are still in step 1', async () => {
    const aUserGate = deferred()
    const bUserGate = deferred()
    const persisted: string[] = []
    let aStarted = false
    let aTerminal = false
    const parkUntilAbort = (_ms: number, signal?: AbortSignal) =>
      new Promise<void>((_resolve, reject) => {
        signal?.addEventListener(
          'abort',
          () => reject(new DeviceLoginError({ reason: 'aborted', message: 'aborted' })),
          { once: true },
        )
      })
    const gatedHttp = (userGate: Promise<void>, token: { statusCode: number; bodyText: string }): HttpFn =>
      async ({ url }) => {
        if (url.endsWith('/deviceauth/usercode')) {
          await userGate
          return USERCODE_OK
        }
        if (url.endsWith('/deviceauth/token')) return token
        if (url.endsWith('/oauth/token')) return EXCHANGE_OK
        throw new Error(`unexpected url ${url}`)
      }

    const aPromise = startDeviceLogin({
      canonicalUser: 'alice',
      http: gatedHttp(aUserGate.promise, { statusCode: 403, bodyText: '' }),
      sleep: parkUntilAbort,
      persist: () => {
        persisted.push('a')
        return { accountId: 'a' }
      },
      handlers: {
        onStarted: () => {
          aStarted = true
        },
        onSuccess: () => {
          aTerminal = true
        },
        onExpired: () => {
          aTerminal = true
        },
        onFailed: () => {
          aTerminal = true
        },
      },
    })
    const onSuccessB = deferred()
    const bPromise = startDeviceLogin({
      canonicalUser: 'alice',
      http: gatedHttp(bUserGate.promise, TOKEN_200),
      sleep: async () => {},
      persist: () => {
        persisted.push('b')
        return { accountId: 'b' }
      },
      handlers: {
        onStarted: () => {},
        onSuccess: () => onSuccessB.resolve(),
        onExpired: () => {},
        onFailed: () => {},
      },
    })

    bUserGate.resolve()
    const bRes = await bPromise
    assert.deepEqual(bRes, { ok: true })
    await onSuccessB.promise

    aUserGate.resolve()
    const aRes = await aPromise
    assert.equal(aRes.ok, false, 'superseded first login must not report started')
    assert.equal(aStarted, false, 'superseded first login must not push an init card')
    await new Promise(r => setImmediate(r))
    assert.equal(aTerminal, false)
    assert.deepEqual(persisted, ['b'])
    assert.equal(inFlightDeviceLoginCount(), 0)
  })

  // Regression (§3.6b): an abort landing while the token poll 200 is in flight
  // must not fall through to exchange + persist + success card.
  it('an abort during the in-flight poll 200 does not exchange, persist, or fire handlers', async () => {
    const tokenGate = deferred()
    const persisted: string[] = []
    let terminal = false
    const http: HttpFn = async ({ url }) => {
      if (url.endsWith('/deviceauth/usercode')) return USERCODE_OK
      if (url.endsWith('/deviceauth/token')) {
        await tokenGate.promise
        return TOKEN_200
      }
      if (url.endsWith('/oauth/token')) return EXCHANGE_OK
      throw new Error(`unexpected url ${url}`)
    }
    const res = await startDeviceLogin({
      canonicalUser: 'alice',
      http,
      sleep: async () => {},
      persist: () => {
        persisted.push('x')
        return { accountId: 'x' }
      },
      handlers: {
        onStarted: () => {},
        onSuccess: () => {
          terminal = true
        },
        onExpired: () => {
          terminal = true
        },
        onFailed: () => {
          terminal = true
        },
      },
    })
    assert.deepEqual(res, { ok: true })
    // The detached loop is parked inside the token poll round-trip.
    assert.equal(abortAllDeviceLogins(), 1)
    tokenGate.resolve()
    await new Promise(r => setImmediate(r))
    await new Promise(r => setImmediate(r))
    assert.deepEqual(persisted, [])
    assert.equal(terminal, false)
    assert.equal(inFlightDeviceLoginCount(), 0)
  })

  // Regression (§3.6b): same for an abort landing during the exchange
  // round-trip — the tokens must not be persisted after the fact.
  it('an abort during the in-flight exchange does not persist or fire handlers', async () => {
    const exchangeGate = deferred()
    const persisted: string[] = []
    let terminal = false
    const http: HttpFn = async ({ url }) => {
      if (url.endsWith('/deviceauth/usercode')) return USERCODE_OK
      if (url.endsWith('/deviceauth/token')) return TOKEN_200
      if (url.endsWith('/oauth/token')) {
        await exchangeGate.promise
        return EXCHANGE_OK
      }
      throw new Error(`unexpected url ${url}`)
    }
    const res = await startDeviceLogin({
      canonicalUser: 'alice',
      http,
      sleep: async () => {},
      persist: () => {
        persisted.push('x')
        return { accountId: 'x' }
      },
      handlers: {
        onStarted: () => {},
        onSuccess: () => {
          terminal = true
        },
        onExpired: () => {
          terminal = true
        },
        onFailed: () => {
          terminal = true
        },
      },
    })
    assert.deepEqual(res, { ok: true })
    // The detached loop is parked inside the exchange round-trip.
    assert.equal(abortAllDeviceLogins(), 1)
    exchangeGate.resolve()
    await new Promise(r => setImmediate(r))
    await new Promise(r => setImmediate(r))
    assert.deepEqual(persisted, [])
    assert.equal(terminal, false)
    assert.equal(inFlightDeviceLoginCount(), 0)
  })

  // Regression (§3.6c): the poller must hand its AbortSignal to every login
  // HTTP call so an in-flight request is cancellable at the transport layer
  // (production buildHttp passes it to undici alongside explicit timeouts).
  it('all three login HTTP calls receive the abort signal', async () => {
    const sawSignal: Record<string, boolean> = {}
    const http: HttpFn = async ({ url, signal }) => {
      if (url.endsWith('/deviceauth/usercode')) {
        sawSignal.usercode = signal instanceof AbortSignal
        return USERCODE_OK
      }
      if (url.endsWith('/deviceauth/token')) {
        sawSignal.token = signal instanceof AbortSignal
        return TOKEN_200
      }
      if (url.endsWith('/oauth/token')) {
        sawSignal.exchange = signal instanceof AbortSignal
        return EXCHANGE_OK
      }
      throw new Error(`unexpected url ${url}`)
    }
    const onSuccess = deferred()
    await startDeviceLogin({
      canonicalUser: 'alice',
      http,
      sleep: async () => {},
      persist: () => ({ accountId: 'x' }),
      handlers: {
        onStarted: () => {},
        onSuccess: () => onSuccess.resolve(),
        onExpired: () => {},
        onFailed: () => {},
      },
    })
    await onSuccess.promise
    assert.deepEqual(sawSignal, { usercode: true, token: true, exchange: true })
  })
})
