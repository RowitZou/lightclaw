import assert from 'node:assert/strict'
import { after, afterEach, before, describe, it } from 'node:test'

import { installTestConfigHome } from '../test-support/config-fixture.js'
import {
  _setBraveHttpGetForTests,
  fetchBraveSearch,
} from './web-search-brave.js'
import { _setWebRetryDelaysForTests } from './web-retry.js'

// fetchBraveSearch reads runtime.network.proxy via getConfig(), which throws
// when no config.json exists — install a minimal one so these unit tests do
// not depend on the developer's ~/.lightclaw/config.json.
let restoreConfigHome: () => void
before(() => {
  restoreConfigHome = installTestConfigHome()
})
after(() => {
  restoreConfigHome()
})

function buildBraveResponse(opts: {
  status?: number
  statusText?: string
  data?: unknown
}): unknown {
  return {
    status: opts.status ?? 200,
    statusText: opts.statusText ?? 'OK',
    data: opts.data,
    headers: {},
    config: {},
  }
}

describe('web-search-brave (unit, stubbed axios)', () => {
  afterEach(() => {
    _setBraveHttpGetForTests(null)
    _setWebRetryDelaysForTests(null)
  })

  it('200 + web.results[]: maps to {title, url, snippet}', async () => {
    // Standard Brave shape: web.results[] with title/url/description per
    // entry. The provider should pass through verbatim, just renaming
    // description → snippet for the WebSearchResult contract.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _setBraveHttpGetForTests(((async () =>
      buildBraveResponse({
        data: {
          web: {
            results: [
              { title: 'foo', url: 'https://a.com', description: 'about foo' },
              { title: 'bar', url: 'https://b.com', description: 'about bar' },
            ],
          },
        },
      })) as any))
    const ctrl = new AbortController()
    const results = await fetchBraveSearch('test-key', {
      query: 'q',
      count: 10,
      signal: ctrl.signal,
    })
    assert.equal(results.length, 2)
    assert.deepEqual(results[0], { title: 'foo', url: 'https://a.com', snippet: 'about foo' })
    assert.deepEqual(results[1], { title: 'bar', url: 'https://b.com', snippet: 'about bar' })
  })

  it('200 + flat results[] (fallback shape): also maps correctly', async () => {
    // Some self-hosted Brave-compatible proxies return a flat `results`
    // instead of nested `web.results`. OpenClaw + Python helper both
    // handle this; mirror that compatibility here.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _setBraveHttpGetForTests(((async () =>
      buildBraveResponse({
        data: {
          results: [{ title: 't', link: 'https://x.com', snippet: 's' }],
        },
      })) as any))
    const ctrl = new AbortController()
    const results = await fetchBraveSearch('test-key', {
      query: 'q',
      count: 5,
      signal: ctrl.signal,
    })
    // `link` aliases `url`, `snippet` aliases `description` (mirrors
    // websearch.py:81-82).
    assert.equal(results.length, 1)
    assert.deepEqual(results[0], { title: 't', url: 'https://x.com', snippet: 's' })
  })

  it('429 Too Many Requests → throws with status + body for admin grep', async () => {
    // Bug 9 / Bug 10 dogfood lesson: collapsing 429 to a generic "error"
    // makes admins blind to quota-vs-network-vs-bad-key. The error
    // message includes the Brave-side response body (truncated to 400
    // chars) so admin can grep `QUOTA_EXCEEDED`.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _setBraveHttpGetForTests(((async () =>
      buildBraveResponse({
        status: 429,
        statusText: 'Too Many Requests',
        data: { error: { code: 'QUOTA_EXCEEDED', detail: 'free plan limit reached' } },
      })) as any))
    const ctrl = new AbortController()
    await assert.rejects(
      () => fetchBraveSearch('test-key', { query: 'q', count: 5, signal: ctrl.signal }),
      (err: Error) => {
        assert.match(err.message, /Brave Search API error 429 Too Many Requests/)
        assert.match(err.message, /QUOTA_EXCEEDED/)
        return true
      },
    )
  })

  it('401 Unauthorized → throws with status + body so model can see bad-key path', async () => {
    // Distinct from 429: bad key means caller config is wrong, retry
    // doesn't help. Body still gets surfaced for admin diagnostics.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _setBraveHttpGetForTests(((async () =>
      buildBraveResponse({
        status: 401,
        statusText: 'Unauthorized',
        data: 'Invalid API key',
      })) as any))
    const ctrl = new AbortController()
    await assert.rejects(
      () => fetchBraveSearch('bad', { query: 'q', count: 5, signal: ctrl.signal }),
      /Brave Search API error 401 Unauthorized.*Invalid API key/,
    )
  })

  it('transient socket error then 200: withWebRetry re-sends and recovers', async () => {
    // The 2026-05-14 dogfood failure mode — a socket reset on the proxy
    // hop. Pre-retry this surfaced as a hard `WebSearch failed (exit 1)`;
    // the first re-send now recovers.
    _setWebRetryDelaysForTests({ baseDelayMs: 1, maxDelayMs: 2 })
    let calls = 0
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _setBraveHttpGetForTests((async () => {
      calls += 1
      if (calls === 1) {
        throw new Error(
          'Client network socket disconnected before secure TLS connection was established',
        )
      }
      return buildBraveResponse({
        data: { web: { results: [{ title: 't', url: 'https://x.com', description: 's' }] } },
      })
    }) as any)
    const ctrl = new AbortController()
    const results = await fetchBraveSearch('test-key', {
      query: 'q',
      count: 5,
      signal: ctrl.signal,
    })
    assert.equal(calls, 2)
    assert.equal(results.length, 1)
  })

  it('503 Service Unavailable: retried via WebRetryableHttpError, then succeeds', async () => {
    // validateStatus:() => true swallows the 503 from axios, so the inner
    // retry fn re-raises it as WebRetryableHttpError for the predicate.
    _setWebRetryDelaysForTests({ baseDelayMs: 1, maxDelayMs: 2 })
    let calls = 0
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _setBraveHttpGetForTests((async () => {
      calls += 1
      if (calls < 3) {
        return buildBraveResponse({
          status: 503,
          statusText: 'Service Unavailable',
          data: 'upstream blip',
        })
      }
      return buildBraveResponse({ data: { web: { results: [] } } })
    }) as any)
    const ctrl = new AbortController()
    const results = await fetchBraveSearch('test-key', {
      query: 'q',
      count: 5,
      signal: ctrl.signal,
    })
    assert.equal(calls, 3)
    assert.equal(results.length, 0)
  })

  it('429 QUOTA_EXCEEDED: NOT retried — fast-fail with body, fn called once', async () => {
    // 429 must stay fast-fail: a monthly-quota miss is not transient and a
    // re-send loop just wastes the user's time. Regression guard that the
    // retry wiring did not accidentally widen the retryable-status set.
    _setWebRetryDelaysForTests({ baseDelayMs: 1, maxDelayMs: 2 })
    let calls = 0
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _setBraveHttpGetForTests((async () => {
      calls += 1
      return buildBraveResponse({
        status: 429,
        statusText: 'Too Many Requests',
        data: { error: { code: 'QUOTA_EXCEEDED' } },
      })
    }) as any)
    const ctrl = new AbortController()
    await assert.rejects(
      () => fetchBraveSearch('k', { query: 'q', count: 5, signal: ctrl.signal }),
      /Brave Search API error 429/,
    )
    assert.equal(calls, 1)
  })
})
