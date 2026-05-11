import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { _setWebFetchSummarizerForTests, webFetchTool } from './web-fetch.js'
import { _clearWebFetchCacheForTests } from './web-fetch-cache.js'
import type { ToolCallContext } from '../tool.js'

const MAX_MARKDOWN_LENGTH = 100_000  // mirror constant in web-fetch.ts

function buildCtx(stdout: string, opts?: { exitCode?: number; stderr?: string }): ToolCallContext {
  return {
    abortSignal: new AbortController().signal,
    runtime: {
      helperRoot: '/fake/helpers',
      workspaceRoot: '/fake/workspace',
      async exec() {
        return {
          stdout,
          stderr: opts?.stderr ?? '',
          exitCode: opts?.exitCode ?? 0,
        }
      },
    },
  } as unknown as ToolCallContext
}

describe('WebFetch tool — prompt + summarize', () => {
  beforeEach(() => {
    _clearWebFetchCacheForTests()
  })
  afterEach(() => {
    _setWebFetchSummarizerForTests(null)
  })

  it('returns raw markdown when no prompt is supplied (back-compat, short content)', async () => {
    let summarizeCalled = false
    _setWebFetchSummarizerForTests(async () => {
      summarizeCalled = true
      return 'should not be called'
    })

    const result = await webFetchTool.call(
      { url: 'https://example.com' },
      buildCtx('# Hello\n\nSome page markdown.'),
    )
    assert.equal(result.isError, undefined)
    assert.match(result.output as string, /# Hello/)
    assert.doesNotMatch(result.output as string, /truncated to/)
    assert.equal(summarizeCalled, false, 'summarize must NOT run without prompt')
  })

  it('truncates raw markdown past MAX_RAW_LENGTH and adds marker pointing to prompt/maxBytes escape hatches', async () => {
    const oversize = 'x'.repeat(60_000)  // > MAX_RAW_LENGTH (50_000)
    const result = await webFetchTool.call(
      { url: 'https://example.com', maxBytes: 100_000 },
      buildCtx(oversize),
    )
    assert.equal(result.isError, undefined)
    // Should slice to 50_000 chars + marker
    assert.ok(
      (result.output as string).length < 51_000,
      `raw should be capped near MAX_RAW_LENGTH (got ${(result.output as string).length})`,
    )
    assert.match(result.output as string, /Page is 60000 chars, truncated to 50000/)
    assert.match(result.output as string, /pass `prompt` to use the sub-LLM summarize path/)
    assert.match(result.output as string, /pass `maxBytes` up to 100000/)
  })

  it('calls summarize when prompt + non-preapproved URL', async () => {
    let capturedPrompt = ''
    let capturedUrl = ''
    _setWebFetchSummarizerForTests(async (input) => {
      capturedPrompt = input.prompt
      capturedUrl = input.url
      return 'summary: foo answer.'
    })

    const result = await webFetchTool.call(
      { url: 'https://example.com/blog/x', prompt: 'what is foo?' },
      buildCtx('Markdown about foo.'),
    )
    assert.equal(result.isError, undefined)
    assert.equal(result.output, 'summary: foo answer.')
    assert.equal(capturedPrompt, 'what is foo?')
    assert.equal(capturedUrl, 'https://example.com/blog/x')
  })

  it('skips summarize for preapproved domain + short content (returns raw with note)', async () => {
    let summarizeCalled = false
    _setWebFetchSummarizerForTests(async () => {
      summarizeCalled = true
      return 'should not be called'
    })

    const result = await webFetchTool.call(
      { url: 'https://docs.python.org/3/library/asyncio.html', prompt: 'what is asyncio.gather' },
      buildCtx('# asyncio\n\nShort docs content.'),
    )
    assert.equal(result.isError, undefined)
    assert.match(result.output as string, /\[Preapproved domain — sub-LLM summarize skipped/)
    assert.match(result.output as string, /# asyncio/)
    assert.equal(summarizeCalled, false, 'preapproved short content must skip summarize')
  })

  it('truncates oversized markdown before passing to summarize', async () => {
    let capturedMarkdown = ''
    _setWebFetchSummarizerForTests(async (input) => {
      capturedMarkdown = input.markdown
      return 'truncated summary'
    })

    const oversize = 'x'.repeat(MAX_MARKDOWN_LENGTH + 5000)
    const result = await webFetchTool.call(
      { url: 'https://example.com/long', prompt: 'summarize' },
      buildCtx(oversize),
    )
    assert.equal(result.output, 'truncated summary')
    // truncated content = MAX_MARKDOWN_LENGTH chars + marker line
    assert.ok(
      capturedMarkdown.length <= MAX_MARKDOWN_LENGTH + 100,
      `markdown handed to summarize should be roughly capped (got ${capturedMarkdown.length})`,
    )
    assert.match(capturedMarkdown, /\[Content truncated due to length\.\.\.\]$/)
  })

  it('falls back to raw markdown with [failed] prefix when summarize throws', async () => {
    _setWebFetchSummarizerForTests(async () => {
      throw new Error('upstream rate limited')
    })

    const result = await webFetchTool.call(
      { url: 'https://example.com/page', prompt: 'summarize' },
      buildCtx('# Original Page\n\nFull body.'),
    )
    assert.equal(result.isError, undefined, 'summarize failure is recoverable, not isError')
    assert.match(result.output as string, /\[WebFetch summarize failed: upstream rate limited/)
    assert.match(result.output as string, /# Original Page/)
  })
})
