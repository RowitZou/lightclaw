import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'

import type { ToolCallContext } from '../tool.js'
import { _setBraveHttpGetForTests } from './web-search-brave.js'
import { _setDdgHttpGetForTests } from './web-search-ddg.js'
import { webSearchTool } from './web-search.js'

/** Minimal ToolCallContext for WebSearch (no runtime.fs / no helper exec
 *  — Phase 34 daemon-side). */
function buildCtx(): ToolCallContext {
  return {
    abortSignal: new AbortController().signal,
    runtime: {
      workspaceRoot: '/fake/workspace',
    },
  } as unknown as ToolCallContext
}

/** Stub Brave to return a fixed result set (or empty). */
function stubBrave(results: Array<{ title: string; url: string; description: string }>): void {
  _setBraveHttpGetForTests((async () => ({
    status: 200,
    statusText: 'OK',
    data: { web: { results } },
    headers: {},
    config: {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  })) as any)
}

/** Stub DDG to return a fixed result set as Lite HTML (which the DDG
 *  module then regex-parses). Easier than building DDG-HTML for every
 *  test: hand a minimal HTML stub matching the regex contract. */
function stubDdg(results: Array<{ title: string; url: string; snippet: string }>): void {
  const html = results
    .map(
      (r) => `
<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(r.url)}">${r.title}</a>
<a class="result__snippet" href="">${r.snippet}</a>
`,
    )
    .join('\n')
  _setDdgHttpGetForTests((async () => ({
    status: 200,
    statusText: 'OK',
    data: `<html><body>${html}</body></html>`,
    headers: {},
    config: {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  })) as any)
}

const ORIGINAL_BRAVE_KEY = process.env.BRAVE_SEARCH_API_KEY

describe('WebSearch tool — Brave + DDG fallback chain', () => {
  beforeEach(() => {
    process.env.BRAVE_SEARCH_API_KEY = 'test-key'
  })
  afterEach(() => {
    _setBraveHttpGetForTests(null)
    _setDdgHttpGetForTests(null)
    if (ORIGINAL_BRAVE_KEY === undefined) delete process.env.BRAVE_SEARCH_API_KEY
    else process.env.BRAVE_SEARCH_API_KEY = ORIGINAL_BRAVE_KEY
  })

  it('Brave returns results: rendered as numbered markdown list + REMINDER trailer', async () => {
    stubBrave([
      { title: 'Foo Paper', url: 'https://arxiv.org/abs/1234', description: 'About foo.' },
      { title: 'Bar Blog', url: 'https://example.com/bar', description: 'About bar.' },
    ])
    const result = await webSearchTool.call({ query: 'foo bar' }, buildCtx())
    assert.equal(result.isError, undefined)
    const out = result.output as string
    assert.match(out, /^# Search results for: foo bar/)
    assert.match(out, /1\. \[Foo Paper\]\(https:\/\/arxiv\.org\/abs\/1234\)/)
    assert.match(out, / {3}About foo\./)
    assert.match(out, /2\. \[Bar Blog\]\(https:\/\/example\.com\/bar\)/)
    // REMINDER trailer must be the last block, verbatim
    assert.match(out, /REMINDERS:\n- Search snippets are short/)
    assert.match(out, /MANDATORY: After answering using WebSearch results/)
    // Absence / off-target guidance: a search miss is not proof the thing
    // doesn't exist, and a look-alike result must not be substituted
    // (2026-05-13 RowitZou/lightclaw dogfood).
    assert.match(out, /are NOT proof it does not exist/)
    assert.match(out, /do not substitute a similarly-named but different result/)
  })

  it('Brave returns empty → automatic DDG fallback', async () => {
    stubBrave([])
    stubDdg([
      { title: 'DDG hit', url: 'https://example.com/ddg', snippet: 'from ddg' },
    ])
    const result = await webSearchTool.call({ query: 'q' }, buildCtx())
    assert.equal(result.isError, undefined)
    const out = result.output as string
    assert.match(out, /1\. \[DDG hit\]\(https:\/\/example\.com\/ddg\)/)
    assert.match(out, /from ddg/)
  })

  it('Brave returns nothing OR no key → DDG fallback path delivers results', async () => {
    // Two sources of "no Brave results": (a) env key unset AND config has
    // no key, or (b) Brave returned an empty web.results[]. Both route to
    // DDG. We can't reliably test "no key skip Brave entirely" because
    // config.tools.webSearch.braveApiKey is set in admin config and
    // overrides env deletion — so this test verifies the fallback path
    // regardless of which signal triggers it: stub Brave to empty, stub
    // DDG to a known fixture, expect DDG output.
    delete process.env.BRAVE_SEARCH_API_KEY
    stubBrave([])
    stubDdg([
      { title: 'DDG fallback hit', url: 'https://example.com/n', snippet: 'no key path' },
    ])
    const result = await webSearchTool.call({ query: 'q' }, buildCtx())
    assert.equal(result.isError, undefined)
    assert.match(result.output as string, /DDG fallback hit/)
  })

  it('allowed_domains: filters out non-matching hosts (suffix-after-dot match)', async () => {
    // arxiv.org is allowed → both arxiv.org and www.arxiv.org match
    // (suffix-after-dot rule); example.com is filtered out.
    stubBrave([
      { title: 'arxiv top', url: 'https://arxiv.org/abs/1', description: 'a' },
      { title: 'sub arxiv', url: 'https://www.arxiv.org/abs/2', description: 'b' },
      { title: 'other', url: 'https://example.com/x', description: 'c' },
    ])
    const result = await webSearchTool.call(
      { query: 'q', allowed_domains: ['arxiv.org'] },
      buildCtx(),
    )
    const out = result.output as string
    assert.match(out, /arxiv top/)
    assert.match(out, /sub arxiv/)
    assert.doesNotMatch(out, /other/)
  })

  it('blocked_domains: filters out matching hosts', async () => {
    stubBrave([
      { title: 'keep', url: 'https://example.com/k', description: '' },
      { title: 'drop', url: 'https://spam.example/x', description: '' },
    ])
    const result = await webSearchTool.call(
      { query: 'q', blocked_domains: ['spam.example'] },
      buildCtx(),
    )
    const out = result.output as string
    assert.match(out, /keep/)
    assert.doesNotMatch(out, /drop/)
  })

  it('Brave error → WebSearch failed envelope, no auto-DDG fallback on hard error', async () => {
    // Distinct from "Brave returns 0": this is Brave throwing. We do NOT
    // try DDG as second attempt (the model already pays a turn for the
    // failure tool_result; surfacing the Brave error is what admin needs
    // to see — DDG fallback is for "Brave returned no result", not
    // "Brave is down").
    _setBraveHttpGetForTests((async () => ({
      status: 429,
      statusText: 'Too Many Requests',
      data: { error: { code: 'QUOTA_EXCEEDED' } },
      headers: {},
      config: {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    })) as any)
    const result = await webSearchTool.call({ query: 'q' }, buildCtx())
    assert.equal(result.isError, true)
    assert.match(result.output as string, /^WebSearch failed \(exit 1\): /)
    assert.match(result.output as string, /Brave Search API error 429/)
    assert.match(result.output as string, /QUOTA_EXCEEDED/)
  })

  it('no results from either provider: "No search results found." rendered, trailer still appended', async () => {
    stubBrave([])
    stubDdg([])
    const result = await webSearchTool.call({ query: 'q' }, buildCtx())
    assert.equal(result.isError, undefined)
    const out = result.output as string
    assert.match(out, /^# Search results for: q\n\nNo search results found\./)
    assert.match(out, /REMINDERS:/)
    // The absence bullet matters most on a zero-result body: the model must
    // not read "No search results found." as proof the target doesn't exist.
    assert.match(out, /are NOT proof it does not exist/)
  })
})
