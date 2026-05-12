import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'

import {
  _clearWebFetchCacheForTests,
  _setExpiredEntryForTests,
  _webFetchCacheSizeForTests,
  cachedFetchAgeSeconds,
  getCachedFetch,
  setCachedFetch,
} from './web-fetch-cache.js'

import { _setWebFetchSummarizerForTests, webFetchTool } from './web-fetch.js'
import { _setDaemonFetchUrlForTests } from './web-fetch-http.js'
import type { ToolCallContext } from '../tool.js'

describe('web-fetch-cache (unit)', () => {
  beforeEach(() => {
    _clearWebFetchCacheForTests()
  })

  it('round-trips a value through set/get within TTL', () => {
    setCachedFetch('https://example.com', 'q1', 'hello world')
    assert.equal(getCachedFetch('https://example.com', 'q1'), 'hello world')
    const age = cachedFetchAgeSeconds('https://example.com', 'q1')
    assert.ok(age !== undefined && age < 2, `age should be ~0s, got ${age}`)
  })

  it('different prompts on same URL are isolated', () => {
    setCachedFetch('https://example.com', 'about-a', 'answer-a')
    setCachedFetch('https://example.com', 'about-b', 'answer-b')
    assert.equal(getCachedFetch('https://example.com', 'about-a'), 'answer-a')
    assert.equal(getCachedFetch('https://example.com', 'about-b'), 'answer-b')
  })

  it('no-prompt and empty-prompt share the same key', () => {
    setCachedFetch('https://example.com', undefined, 'raw')
    assert.equal(getCachedFetch('https://example.com', ''), 'raw')
  })

  it('expired entry is evicted on lookup', () => {
    _setExpiredEntryForTests('https://example.com', 'q', 'stale')
    assert.equal(getCachedFetch('https://example.com', 'q'), undefined)
    assert.equal(_webFetchCacheSizeForTests(), 0, 'expired entry should be removed')
  })

  it('LRU eviction at cap 64', () => {
    for (let i = 0; i < 70; i += 1) {
      setCachedFetch(`https://example.com/${i}`, undefined, `v${i}`)
    }
    assert.equal(_webFetchCacheSizeForTests(), 64)
    // Oldest entries (0..5) should have been evicted
    assert.equal(getCachedFetch('https://example.com/0', undefined), undefined)
    assert.equal(getCachedFetch('https://example.com/69', undefined), 'v69')
  })
})

/**
 * Build a minimal ToolCallContext + arrange a daemonFetchUrl stub. The
 * `body` is delivered as text/plain so textBodyToMarkdown's else branch
 * does only trim (no turndown DOM walk), making the body pass through
 * byte-for-byte. fetchCount tracks call count to verify cache short-
 * circuits the fetch call (Phase 34: replaces the runtime.exec count
 * the pre-migration tests used).
 */
function buildCtxWithFetch(body: string, fetchCount: { n: number }): ToolCallContext {
  _setDaemonFetchUrlForTests(async () => {
    fetchCount.n += 1
    return {
      status: 200,
      finalUrl: 'https://example.com/',
      contentType: 'text/plain; charset=utf-8',
      bytes: Buffer.from(body, 'utf-8'),
    }
  })
  return {
    abortSignal: new AbortController().signal,
    runtime: {
      helperRoot: '/fake/helpers',
      workspaceRoot: '/fake/workspace',
      fs: { async writeFile() {} },
    },
  } as unknown as ToolCallContext
}

describe('WebFetch integration with cache', () => {
  beforeEach(() => {
    _clearWebFetchCacheForTests()
  })
  afterEach(() => {
    _setWebFetchSummarizerForTests(null)
    _setDaemonFetchUrlForTests(null)
  })

  it('second call to same URL+prompt skips exec AND summarize (cache hit)', async () => {
    const fetchCount = { n: 0 }
    let summarizeCount = 0
    _setWebFetchSummarizerForTests(async () => {
      summarizeCount += 1
      return 'summary text'
    })

    // First call: cold cache, fetch + summarize run
    const r1 = await webFetchTool.call(
      { url: 'https://example.com/blog', prompt: 'what is foo?' },
      buildCtxWithFetch('Page about foo.', fetchCount),
    )
    assert.equal(r1.output, 'summary text')
    assert.equal(fetchCount.n, 1)
    assert.equal(summarizeCount, 1)

    // Second call: cache hit, neither exec nor summarize run
    const r2 = await webFetchTool.call(
      { url: 'https://example.com/blog', prompt: 'what is foo?' },
      buildCtxWithFetch('UNUSED', fetchCount),
    )
    assert.equal(r2.output, 'summary text')
    assert.equal(fetchCount.n, 1, 'fetch should NOT be re-called on cache hit')
    assert.equal(summarizeCount, 1, 'summarize should NOT be re-called on cache hit')
  })

  it('different prompts on same URL each trigger a fresh fetch', async () => {
    const fetchCount = { n: 0 }
    _setWebFetchSummarizerForTests(async (input) => `summary for "${input.prompt}"`)

    await webFetchTool.call(
      { url: 'https://example.com/blog', prompt: 'foo' },
      buildCtxWithFetch('Body', fetchCount),
    )
    await webFetchTool.call(
      { url: 'https://example.com/blog', prompt: 'bar' },
      buildCtxWithFetch('Body', fetchCount),
    )
    assert.equal(fetchCount.n, 2, 'each new prompt should trigger fresh fetch')
  })

  it('summarize failure result is NOT cached (next call retries)', async () => {
    const fetchCount = { n: 0 }
    let summarizeCount = 0
    _setWebFetchSummarizerForTests(async () => {
      summarizeCount += 1
      throw new Error('rate limited')
    })

    const r1 = await webFetchTool.call(
      { url: 'https://example.com/blog', prompt: 'q' },
      buildCtxWithFetch('Body', fetchCount),
    )
    assert.match(r1.output as string, /\[WebFetch summarize failed/)

    // Second call: summarize should be attempted again (failure not cached)
    const r2 = await webFetchTool.call(
      { url: 'https://example.com/blog', prompt: 'q' },
      buildCtxWithFetch('Body', fetchCount),
    )
    assert.match(r2.output as string, /\[WebFetch summarize failed/)
    assert.equal(summarizeCount, 2, 'summarize should be retried on second call')
  })

  it('raw-mode (no prompt) result is cached', async () => {
    const fetchCount = { n: 0 }
    let summarizeCount = 0
    _setWebFetchSummarizerForTests(async () => {
      summarizeCount += 1
      return 'unused'
    })

    const r1 = await webFetchTool.call(
      { url: 'https://example.com/raw' },
      buildCtxWithFetch('# raw body', fetchCount),
    )
    const r2 = await webFetchTool.call(
      { url: 'https://example.com/raw' },
      buildCtxWithFetch('UNUSED', fetchCount),
    )
    // Cache returns the EXACT bytes the first fetch produced, including the
    // 5-line header (URL/Status/Content-Type/Bytes/blank) that the daemon
    // tool layer prepends. The two outputs must be identical (byte-for-byte
    // cache hit) and the body must include the seed text.
    assert.equal(r1.output, r2.output)
    assert.match(r1.output as string, /# raw body/)
    assert.match(r1.output as string, /^URL: https:\/\/example\.com\//)
    assert.equal(fetchCount.n, 1, 'cache hit avoids fetch')
    assert.equal(summarizeCount, 0, 'no-prompt path never calls summarize')
  })
})
