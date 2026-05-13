import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { _setWebFetchSummarizerForTests, webFetchTool } from './web-fetch.js'
import { _clearWebFetchCacheForTests } from './web-fetch-cache.js'
import { _setDaemonFetchUrlForTests } from './web-fetch-http.js'
import type { ToolCallContext } from '../tool.js'

const MAX_MARKDOWN_LENGTH = 100_000  // mirror constant in web-fetch.ts

/**
 * Build a minimal ToolCallContext that records any binary writes to a
 * memory map (so tests can assert the binary path was taken). The
 * `runtime.fs.writeFile` shim is sufficient for the test surface; real
 * runtime.exec / runtime.exec are no longer called by daemon-side
 * WebFetch (Phase 34).
 */
function buildCtx(opts?: {
  fsWrites?: Map<string, Buffer>
}): ToolCallContext {
  const writes = opts?.fsWrites
  return {
    abortSignal: new AbortController().signal,
    runtime: {
      workspaceRoot: '/fake/workspace',
      fs: {
        async writeFile(p: string, content: Buffer | string) {
          writes?.set(p, typeof content === 'string' ? Buffer.from(content) : content)
        },
      },
    },
  } as unknown as ToolCallContext
}

/**
 * Stub daemonFetchUrl to return text content. The `body` becomes the bytes
 * delivered to the WebFetch tool; `contentType` defaults to text/plain so
 * the body passes through textBodyToMarkdown's `else` branch (trim only),
 * leaving the test's body string byte-for-byte in the rendered output.
 * Using text/plain instead of text/html avoids turndown's DOM walk which
 * would mutate test fixtures.
 */
function stubFetch(opts: {
  body: string
  contentType?: string
  status?: number
  finalUrl?: string
}): void {
  _setDaemonFetchUrlForTests(async () => ({
    status: opts.status ?? 200,
    finalUrl: opts.finalUrl ?? 'https://example.com/',
    contentType: opts.contentType ?? 'text/plain; charset=utf-8',
    bytes: Buffer.from(opts.body, 'utf-8'),
  }))
}

describe('WebFetch tool — prompt + summarize', () => {
  beforeEach(() => {
    _clearWebFetchCacheForTests()
  })
  afterEach(() => {
    _setWebFetchSummarizerForTests(null)
    _setDaemonFetchUrlForTests(null)
  })

  it('returns raw markdown when no prompt is supplied (back-compat, short content)', async () => {
    let summarizeCalled = false
    _setWebFetchSummarizerForTests(async () => {
      summarizeCalled = true
      return 'should not be called'
    })
    stubFetch({ body: '# Hello\n\nSome page markdown.' })

    const result = await webFetchTool.call(
      { url: 'https://example.com' },
      buildCtx(),
    )
    assert.equal(result.isError, undefined)
    assert.match(result.output as string, /# Hello/)
    assert.doesNotMatch(result.output as string, /truncated to/)
    assert.equal(summarizeCalled, false, 'summarize must NOT run without prompt')
  })

  it('truncates raw markdown past MAX_RAW_LENGTH and adds marker pointing to maxBytes escape hatch', async () => {
    const oversize = 'x'.repeat(60_000)  // > MAX_RAW_LENGTH (50_000)
    stubFetch({ body: oversize })
    const result = await webFetchTool.call(
      { url: 'https://example.com', maxBytes: 100_000 },
      buildCtx(),
    )
    assert.equal(result.isError, undefined)
    // Should slice to 50_000 chars + marker
    assert.ok(
      (result.output as string).length < 51_000,
      `raw should be capped near MAX_RAW_LENGTH (got ${(result.output as string).length})`,
    )
    // The full rendered text contains the 5-line header (URL/Status/CT/Bytes/blank)
    // then the body. Truncation marker quotes the full rendered length.
    assert.match(result.output as string, /truncated to 50000/)
    assert.match(result.output as string, /pass `maxBytes` up to 100000/)
    // The sub-LLM `prompt` path is NOT advertised here — it sees the same
    // helper output, so suggesting it as an "escape hatch" would mislead the
    // main agent.
    assert.doesNotMatch(result.output as string, /pass `prompt`/)
  })

  it('calls summarize when prompt + non-preapproved URL', async () => {
    let capturedPrompt = ''
    let capturedUrl = ''
    _setWebFetchSummarizerForTests(async (input) => {
      capturedPrompt = input.prompt
      capturedUrl = input.url
      return 'summary: foo answer.'
    })
    stubFetch({ body: 'Markdown about foo.' })

    const result = await webFetchTool.call(
      { url: 'https://example.com/blog/x', prompt: 'what is foo?' },
      buildCtx(),
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
    stubFetch({ body: '# asyncio\n\nShort docs content.' })

    const result = await webFetchTool.call(
      { url: 'https://docs.python.org/3/library/asyncio.html', prompt: 'what is asyncio.gather' },
      buildCtx(),
    )
    assert.equal(result.isError, undefined)
    assert.match(result.output as string, /\[Preapproved domain — sub-LLM summarize skipped/)
    assert.match(result.output as string, /# asyncio/)
    assert.equal(summarizeCalled, false, 'preapproved short content must skip summarize')
  })

  it('truncates oversized markdown before passing to summarize', async () => {
    // Daemon migration nuance: body bytes are capped at maxBytes BEFORE
    // textBodyToMarkdown runs (matches helper's max_bytes UTF-8 byte cap).
    // To exercise the TS-side MAX_MARKDOWN_LENGTH branch, we need
    // rendered output (5-line header + body) to exceed MAX_MARKDOWN_LENGTH
    // chars. Set maxBytes to the hard cap (100K) and feed a body of
    // exactly 100K — body passes through daemon truncation untouched
    // (length === cap), then rendered = ~80 header chars + 100K body =
    // ~100080 chars > MAX_MARKDOWN_LENGTH (100K) → truncation branch
    // appends the marker.
    let capturedMarkdown = ''
    _setWebFetchSummarizerForTests(async (input) => {
      capturedMarkdown = input.markdown
      return 'truncated summary'
    })
    const oversize = 'x'.repeat(100_000)  // === MAX_BYTES_HARD_CAP, fits daemon cap
    stubFetch({ body: oversize, contentType: 'text/plain' })
    const result = await webFetchTool.call(
      { url: 'https://example.com/long', prompt: 'summarize', maxBytes: 100_000 },
      buildCtx(),
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
    stubFetch({ body: '# Original Page\n\nFull body.' })

    const result = await webFetchTool.call(
      { url: 'https://example.com/page', prompt: 'summarize' },
      buildCtx(),
    )
    assert.equal(result.isError, undefined, 'summarize failure is recoverable, not isError')
    assert.match(result.output as string, /\[WebFetch summarize failed: upstream rate limited/)
    assert.match(result.output as string, /# Original Page/)
  })
})

describe('WebFetch tool — daemon-side migration regressions', () => {
  beforeEach(() => {
    _clearWebFetchCacheForTests()
  })
  afterEach(() => {
    _setDaemonFetchUrlForTests(null)
    _setWebFetchSummarizerForTests(null)
  })

  it('alphaxiv JSON-LD: turndown preserves <script type="application/ld+json"> abstract', async () => {
    // The 2026-05-12 dogfood proof: turndown (unlike markdownify) walks
    // the DOM and renders <script> bodies inline. Static HTML containing
    // a JSON-LD ScholarlyArticle block with `"abstract":"..."` is the
    // canonical pattern alphaxiv uses; the LLM ends up seeing the
    // abstract text without any per-site smart-extractor logic.
    const html = `
      <html>
        <head><title>Paper Title | alphaXiv</title></head>
        <body>
          <h1>Paper Title</h1>
          <script type="application/ld+json">
            {"@type":"ScholarlyArticle","headline":"Paper Title","abstract":"Foundational claim about deep learning."}
          </script>
        </body>
      </html>
    `
    stubFetch({ body: html, contentType: 'text/html; charset=utf-8' })
    const result = await webFetchTool.call(
      { url: 'https://www.alphaxiv.org/overview/2605.06548' },
      buildCtx(),
    )
    assert.equal(result.isError, undefined)
    assert.match(
      result.output as string,
      /Foundational claim about deep learning/,
      'JSON-LD abstract must surface through turndown',
    )
  })

  it('binary content path: persists to runtime.fs.writeFile under downloads/, returns header + body line', async () => {
    const pdfBytes = Buffer.from('%PDF-1.4 fake content', 'utf-8')
    _setDaemonFetchUrlForTests(async () => ({
      status: 200,
      finalUrl: 'https://arxiv.org/pdf/2509.25721',
      contentType: 'application/pdf',
      bytes: pdfBytes,
    }))
    const writes = new Map<string, Buffer>()
    const result = await webFetchTool.call(
      { url: 'https://arxiv.org/pdf/2509.25721' },
      buildCtx({ fsWrites: writes }),
    )
    assert.equal(result.isError, undefined)
    // Exactly one write under /fake/workspace/.lightclaw/downloads/
    assert.equal(writes.size, 1)
    const [savedPath] = [...writes.keys()]
    assert.match(savedPath, /^\/fake\/workspace\/\.lightclaw\/downloads\/.*\.pdf$/)
    // Output shape mirrors the Python helper byte-for-byte: 5-line header
    // + "[Binary content (...) saved to <path>]" body line.
    assert.match(result.output as string, /^URL: https:\/\/arxiv\.org\/pdf\/2509\.25721/m)
    assert.match(result.output as string, /Content-Type: application\/pdf/)
    assert.match(result.output as string, /\[Binary content \(application\/pdf, \d+(\.\d+)?[A-Z]*B\) saved to/)
  })

  it('4xx HTTP error: surfaces axios message inside WebFetch failed envelope', async () => {
    // Daemon-side WebFetch wraps fetch failures in the same envelope the
    // Python helper used: `WebFetch failed (exit 1): fetch failed: <msg>`.
    // The model relies on the `WebFetch failed (exit 1):` prefix for
    // pattern matching, NOT on the inner error type — so even though
    // axios's message ("Request failed with status code 404") differs
    // from the Python helper's ("HTTP 404"), the model handles both.
    _setDaemonFetchUrlForTests(async () => {
      throw new Error('Request failed with status code 404')
    })
    const result = await webFetchTool.call(
      { url: 'https://example.com/missing' },
      buildCtx(),
    )
    assert.equal(result.isError, true)
    assert.match(result.output as string, /^WebFetch failed \(exit 1\): fetch failed: /)
    assert.match(result.output as string, /404/)
  })

  it('5-line header format: URL / Status / Content-Type / Bytes / blank, byte-equivalent to Python helper', async () => {
    // Regression case: the helper-stdout shape is parsed loosely by the
    // model but admin grep relies on the exact `URL: <url>\nStatus: ...`
    // pattern. Preserve byte-for-byte across the migration.
    stubFetch({
      body: 'plain body',
      contentType: 'text/plain; charset=utf-8',
      status: 200,
      finalUrl: 'https://example.com/',
    })
    const result = await webFetchTool.call(
      { url: 'https://example.com/' },
      buildCtx(),
    )
    const output = result.output as string
    // First 4 lines are the header; 5th line is blank.
    const lines = output.split('\n')
    assert.equal(lines[0], 'URL: https://example.com/')
    assert.equal(lines[1], 'Status: 200')
    assert.equal(lines[2], 'Content-Type: text/plain; charset=utf-8')
    assert.match(lines[3], /^Bytes: \d+$/)
    assert.equal(lines[4], '', 'header → body separator is a blank line')
    assert.equal(lines[5], 'plain body')
  })
})
