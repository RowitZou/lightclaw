import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import {
  _setBraveHttpGetForTests,
  fetchBraveSearch,
} from './web-search-brave.js'

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
})
