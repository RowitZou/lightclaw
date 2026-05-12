import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import {
  _setDdgHttpGetForTests,
  fetchDuckDuckGoSearch,
} from './web-search-ddg.js'

function buildDdgResponse(html: string): unknown {
  return {
    status: 200,
    statusText: 'OK',
    data: html,
    headers: {},
    config: {},
  }
}

/** Fixture: 2 results in DDG's Lite HTML shape. The href wraps real URLs
 *  in /l/?uddg=<real-url>; titles wrap `<b>` highlights; snippets ditto.
 *  Captured from a live response to "deep learning paper". */
const DDG_SAMPLE = `
<html><body>
<div class="result">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Farxiv.org%2Fabs%2F1706.03762&rut=abc">
    Attention Is <b>All</b> You Need - arXiv
  </a>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=...">
    The dominant <b>sequence</b> transduction models are based on complex recurrent.
  </a>
</div>
<div class="result">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.deeplearningbook.org%2F&rut=def">
    Deep Learning Book
  </a>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=...">
    A &quot;textbook&quot; on deep learning by Goodfellow &amp; Bengio.
  </a>
</div>
</body></html>
`

describe('web-search-ddg (unit, stubbed axios)', () => {
  afterEach(() => {
    _setDdgHttpGetForTests(null)
  })

  it('parses DDG Lite HTML: extracts uddg= target URL, decodes entities, strips <b> tags', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _setDdgHttpGetForTests((async () => buildDdgResponse(DDG_SAMPLE)) as any)
    const ctrl = new AbortController()
    const results = await fetchDuckDuckGoSearch({
      query: 'deep learning',
      count: 5,
      signal: ctrl.signal,
    })
    assert.equal(results.length, 2)
    // First result: uddg= unwrapped, <b> stripped from title
    assert.equal(results[0].url, 'https://arxiv.org/abs/1706.03762')
    assert.equal(results[0].title, 'Attention Is All You Need - arXiv')
    assert.match(results[0].snippet, /^The dominant sequence transduction/)
    // Second: HTML entities decoded (&quot; → ", &amp; → &)
    assert.equal(results[1].url, 'https://www.deeplearningbook.org/')
    assert.equal(results[1].title, 'Deep Learning Book')
    assert.equal(
      results[1].snippet,
      'A "textbook" on deep learning by Goodfellow & Bengio.',
    )
  })

  it('empty / captcha response: returns empty array', async () => {
    // DDG sometimes returns an "anomaly detected" page when UA looks
    // bot-like; the regex won't match → empty results. Caller treats
    // empty as "no result" and may surface the no-result render path.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _setDdgHttpGetForTests((async () =>
      buildDdgResponse('<html><body>anomaly detected. Try again later.</body></html>')) as any)
    const ctrl = new AbortController()
    const results = await fetchDuckDuckGoSearch({
      query: 'q',
      count: 5,
      signal: ctrl.signal,
    })
    assert.equal(results.length, 0)
  })

  it('count cap: returns at most `count` results even if more matched', async () => {
    // 5 result blocks in the fixture; count=2 → only 2 returned. Mirrors
    // the Python helper's `blocks[:max_results]` slicing.
    const manyResults = Array.from({ length: 5 }, (_, i) => `
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2F${i}">
        Result ${i}
      </a>
      <a class="result__snippet" href="">snippet ${i}</a>
    `).join('\n')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _setDdgHttpGetForTests((async () =>
      buildDdgResponse(`<html><body>${manyResults}</body></html>`)) as any)
    const ctrl = new AbortController()
    const results = await fetchDuckDuckGoSearch({
      query: 'q',
      count: 2,
      signal: ctrl.signal,
    })
    assert.equal(results.length, 2)
    assert.equal(results[0].url, 'https://example.com/0')
    assert.equal(results[1].url, 'https://example.com/1')
  })
})
