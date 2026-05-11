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

function buildCtx(stdout: string, execCount: { n: number }): ToolCallContext {
  return {
    abortSignal: new AbortController().signal,
    runtime: {
      helperRoot: '/fake/helpers',
      workspaceRoot: '/fake/workspace',
      async exec() {
        execCount.n += 1
        return { stdout, stderr: '', exitCode: 0 }
      },
    },
  } as unknown as ToolCallContext
}

describe('WebFetch integration with cache', () => {
  beforeEach(() => {
    _clearWebFetchCacheForTests()
  })
  afterEach(() => {
    _setWebFetchSummarizerForTests(null)
  })

  it('second call to same URL+prompt skips exec AND summarize (cache hit)', async () => {
    const execCount = { n: 0 }
    let summarizeCount = 0
    _setWebFetchSummarizerForTests(async () => {
      summarizeCount += 1
      return 'summary text'
    })

    // First call: cold cache, exec + summarize run
    const r1 = await webFetchTool.call(
      { url: 'https://example.com/blog', prompt: 'what is foo?' },
      buildCtx('Page about foo.', execCount),
    )
    assert.equal(r1.output, 'summary text')
    assert.equal(execCount.n, 1)
    assert.equal(summarizeCount, 1)

    // Second call: cache hit, neither exec nor summarize run
    const r2 = await webFetchTool.call(
      { url: 'https://example.com/blog', prompt: 'what is foo?' },
      buildCtx('UNUSED', execCount),
    )
    assert.equal(r2.output, 'summary text')
    assert.equal(execCount.n, 1, 'exec should NOT be re-called on cache hit')
    assert.equal(summarizeCount, 1, 'summarize should NOT be re-called on cache hit')
  })

  it('different prompts on same URL each trigger a fresh fetch', async () => {
    const execCount = { n: 0 }
    _setWebFetchSummarizerForTests(async (input) => `summary for "${input.prompt}"`)

    await webFetchTool.call(
      { url: 'https://example.com/blog', prompt: 'foo' },
      buildCtx('Body', execCount),
    )
    await webFetchTool.call(
      { url: 'https://example.com/blog', prompt: 'bar' },
      buildCtx('Body', execCount),
    )
    assert.equal(execCount.n, 2, 'each new prompt should trigger fresh exec')
  })

  it('summarize failure result is NOT cached (next call retries)', async () => {
    const execCount = { n: 0 }
    let summarizeCount = 0
    _setWebFetchSummarizerForTests(async () => {
      summarizeCount += 1
      throw new Error('rate limited')
    })

    const r1 = await webFetchTool.call(
      { url: 'https://example.com/blog', prompt: 'q' },
      buildCtx('Body', execCount),
    )
    assert.match(r1.output as string, /\[WebFetch summarize failed/)

    // Second call: summarize should be attempted again (failure not cached)
    const r2 = await webFetchTool.call(
      { url: 'https://example.com/blog', prompt: 'q' },
      buildCtx('Body', execCount),
    )
    assert.match(r2.output as string, /\[WebFetch summarize failed/)
    assert.equal(summarizeCount, 2, 'summarize should be retried on second call')
  })

  it('raw-mode (no prompt) result is cached', async () => {
    const execCount = { n: 0 }
    let summarizeCount = 0
    _setWebFetchSummarizerForTests(async () => {
      summarizeCount += 1
      return 'unused'
    })

    const r1 = await webFetchTool.call(
      { url: 'https://example.com/raw' },
      buildCtx('# raw body', execCount),
    )
    const r2 = await webFetchTool.call(
      { url: 'https://example.com/raw' },
      buildCtx('UNUSED', execCount),
    )
    assert.equal(r1.output, '# raw body')
    assert.equal(r2.output, '# raw body')
    assert.equal(execCount.n, 1, 'cache hit avoids exec')
    assert.equal(summarizeCount, 0, 'no-prompt path never calls summarize')
  })
})
