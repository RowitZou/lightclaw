/**
 * HTML / JSON / text → markdown extraction layer for daemon-side WebFetch.
 *
 * Mirrors Claude Code's choice in `src/tools/WebFetchTool/utils.ts:90-97 +
 * 456-466`: `new TurndownService()` with zero custom rules, dump-everything.
 * No `.remove(['script','style'])`, no main-content selection. Two reasons:
 *
 *   1. Modern SPAs (Next.js / Nuxt / etc.) embed structured data inside
 *      `<script type="application/ld+json">{"abstract":"..."}</script>` for
 *      SEO. A "smart" extractor (trafilatura / readability) selects visible
 *      `<body>` text and silently drops the ld+json block; turndown's
 *      default child-traversal renders the script body inline so the
 *      abstract reaches the LLM. The alphaxiv overview dogfood case proved
 *      this — markdownify (script-stripping) returned a 269-char placeholder,
 *      turndown returned 86 KB containing the full 1756-char abstract.
 *
 *   2. Pure dump-all is predictable. Smart extractors lie hard on edge
 *      cases (return non-empty placeholder); dump-all returns visibly
 *      noisy markdown that the LLM (or downstream sub-LLM summarize) can
 *      reason about.
 */

import TurndownService from 'turndown'

/**
 * Lazy singleton — defers the `@mixmark-io/domino` import (~200 KB retained
 * heap, transitive dep of turndown) until the first HTML fetch, and reuses
 * one instance across calls. Construction builds 15 rule objects;
 * `.turndown()` itself is stateless so sharing is safe. Mirrors Claude
 * Code's getTurndownService pattern.
 */
let turndownInstance: TurndownService | null = null
function getTurndown(): TurndownService {
  return turndownInstance ?? (turndownInstance = new TurndownService())
}

/**
 * Convert an HTML string to markdown using turndown defaults (no custom
 * rules). The DOM walk preserves `<script>` body text — that's deliberate;
 * see module comment.
 */
export function extractMarkdownFromHtml(html: string): string {
  return getTurndown().turndown(html)
}

/**
 * Render a JSON-shaped response as a fenced code block. On parse failure
 * (server returned `application/json` but body is not valid JSON) we fall
 * through to the raw text — the model still sees the body, just without
 * the pretty-printed wrapper.
 */
export function formatJsonAsMarkdown(text: string): string {
  try {
    return '```json\n' + JSON.stringify(JSON.parse(text), null, 2) + '\n```'
  } catch {
    return text
  }
}

/**
 * Dispatch on Content-Type. HTML / XML / RSS / Atom run through turndown;
 * JSON gets the pretty-printed fence; everything else is treated as plain
 * text with leading/trailing whitespace trimmed. Mirrors the Python helper's
 * `is_html_like` branching in `webfetch.py:298-317` (will be deleted in
 * Phase C).
 */
export function textBodyToMarkdown(text: string, contentType: string): string {
  const ct = contentType.toLowerCase()
  const isHtmlLike =
    ct.includes('html') ||
    ct.includes('xml') ||
    ct.includes('rss') ||
    ct.includes('atom')
  if (isHtmlLike) return extractMarkdownFromHtml(text)
  if (ct.includes('json')) return formatJsonAsMarkdown(text)
  return text.trim()
}

/** Test-only — release the cached turndown instance so a follow-up call
 *  re-imports domino (lets tests reason about cold-start cost). */
export function _resetTurndownForTests(): void {
  turndownInstance = null
}
