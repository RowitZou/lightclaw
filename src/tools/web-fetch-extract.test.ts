import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import {
  _resetTurndownForTests,
  extractMarkdownFromHtml,
  formatJsonAsMarkdown,
  textBodyToMarkdown,
} from './web-fetch-extract.js'

describe('web-fetch-extract (unit)', () => {
  afterEach(() => {
    _resetTurndownForTests()
  })

  it('preserves <script type="application/ld+json"> body — alphaxiv regression', () => {
    // The 2026-05-12 dogfood: alphaxiv overview pages embed the full paper
    // abstract in a JSON-LD ScholarlyArticle block. Smart extractors
    // (trafilatura / markdownify) strip <script> entirely; turndown defaults
    // walk the DOM and render the script body inline. Without this, the
    // model only sees the page title + nav.
    const html = `
      <html>
        <head><title>Continuous Latent Diffusion Language Model | alphaXiv</title></head>
        <body>
          <h1>Paper</h1>
          <script type="application/ld+json">
            {"@type":"ScholarlyArticle","headline":"Cola DLM","abstract":"Cola DLM is a hierarchical latent diffusion language model."}
          </script>
        </body>
      </html>
    `
    const md = extractMarkdownFromHtml(html)
    assert.ok(
      md.includes('Cola DLM is a hierarchical latent diffusion language model'),
      `expected JSON-LD abstract preserved, got:\n${md}`,
    )
  })

  it('preserves plain <script> body text (dump-all dogfood, not just ld+json)', () => {
    // Generalization of the above: turndown walks every node. Hydration
    // state, OpenGraph helper scripts, even inline JS are surfaced. Cost:
    // markdown is noisier than a smart extractor; downstream truncation
    // (MAX_RAW_LENGTH / MAX_MARKDOWN_LENGTH in web-fetch.ts) handles the
    // size budget.
    const html = `<html><body><script>window.__INITIAL_STATE__ = {"foo":42};</script></body></html>`
    const md = extractMarkdownFromHtml(html)
    assert.ok(
      md.includes('window.\\_\\_INITIAL\\_STATE\\_\\_') ||
        md.includes('window.__INITIAL_STATE__'),
      `expected inline JS surfaced, got:\n${md}`,
    )
  })

  it('format JSON pretty-prints valid input inside a fence', () => {
    const out = formatJsonAsMarkdown('{"a":1,"b":[2,3]}')
    assert.match(out, /^```json\n/)
    assert.match(out, /\n```$/)
    assert.match(out, /"a": 1/)
    assert.match(out, /"b": \[/)
  })

  it('format JSON falls through to raw text on parse failure', () => {
    // Server claims application/json but body is HTML or truncated. Don't
    // crash, just hand the raw bytes to the model — better than synthesizing
    // an error.
    const out = formatJsonAsMarkdown('not actually json {{{')
    assert.equal(out, 'not actually json {{{')
  })

  it('plain text path: trim whitespace, no markdown conversion', () => {
    // Content-Type: text/plain or unknown — caller routes here via
    // textBodyToMarkdown's else branch. Helper used to strip via Python's
    // .strip(); we use JS .trim() which is the same semantic (whitespace
    // both ends).
    const out = textBodyToMarkdown('   hello\nworld   \n\n', 'text/plain; charset=utf-8')
    assert.equal(out, 'hello\nworld')
  })

  it('content-type routing: HTML→turndown, JSON→fenced, RSS→turndown, plain→trim', () => {
    const html = '<p>hi</p>'
    const json = '{"x":1}'
    const rss = '<rss><channel><item><title>t</title></item></channel></rss>'
    const plain = '  bare text  '
    assert.ok(textBodyToMarkdown(html, 'text/html').includes('hi'))
    assert.match(textBodyToMarkdown(json, 'application/json'), /^```json/)
    // RSS uses XML/HTML branch; turndown renders it without crashing
    assert.equal(typeof textBodyToMarkdown(rss, 'application/rss+xml'), 'string')
    assert.equal(textBodyToMarkdown(plain, ''), 'bare text')
  })
})
