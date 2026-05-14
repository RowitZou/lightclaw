import { z } from 'zod'

import { getConfig } from '../config.js'
import { buildTool } from '../tool.js'
import {
  fetchBraveSearch,
  type WebSearchResult,
} from './web-search-brave.js'
import { fetchDuckDuckGoSearch } from './web-search-ddg.js'

// Trailer appended to every WebSearch tool_result. Bug 7 in the 2026-05-10
// audit: prior trailer was just one cite-sources line, which let codex /
// gpt-5.x close the loop after a single search even when the snippet was a
// stale headline that didn't actually answer the question. The expanded
// guidance pushes the model toward a follow-up WebFetch when snippets are
// thin, anchors year terms to the system-prompt's Current date, and forces
// a Sources section so the user can audit upstream.
//
// 2026-05-13 dogfood: a `RowitZou LightClaw` search returned only same-name
// repos from other owners; the model treated the miss as proof the repo did
// not exist and cloned the wrong one. The absence / off-target bullet tells
// the model that a search miss is not proof, not to substitute a look-alike,
// and to hit the authoritative source (here the GitHub API) directly.
const REMINDER = [
  'REMINDERS:',
  '- Search snippets are short and may be stale, partial, or contain only headlines.',
  '- If a snippet does not directly answer the user\'s question (e.g. the user asked for a specific value but the snippet only shows headlines, or the snippet timestamp is older than today), follow up with WebFetch on the most authoritative link to retrieve the actual page content. Do NOT fabricate answers from partial snippets.',
  '- Zero results, or results that do not include the specific thing you were asked to find, are NOT proof it does not exist — search indexes lag on new or niche pages. Do not conclude "not found" and do not substitute a similarly-named but different result. Reformulate the query, or go to the authoritative source directly with WebFetch (e.g. a project\'s GitHub API, the official docs domain) even when no search result links to it.',
  '- Use the current year (from the system prompt\'s Current date) in search queries; last-year terms pull stale results.',
  '- MANDATORY: After answering using WebSearch results, include a "Sources:" section listing the actual URLs as Markdown hyperlinks.',
].join('\n')

const DEFAULT_MAX_RESULTS = 10

export const webSearchTool = buildTool({
  name: 'WebSearch',
  shouldDefer: true,
  description: 'Search the web from the environment runtime. Returns search findings and source URLs. Snippets are short and may be stale or partial — when they do not directly answer the question, follow up with WebFetch on the top result. Always cite sources.',
  domain: 'environment',
  // Network egress: the query string leaves the host (potentially leaking
  // sensitive keywords to the search vendor), so this is not "safe" in the
  // same sense as Read/Grep. Aligned with WebFetch (also 'execute') so
  // admins get a confirmation prompt for any outbound web access in
  // default mode.
  riskLevel: 'execute',
  concurrencySafe: true,
  inputSchema: z.object({
    query: z.string().min(2),
    allowed_domains: z.array(z.string()).optional(),
    blocked_domains: z.array(z.string()).optional(),
    max_results: z.number().int().min(1).max(20).optional(),
  }),
  async call(input, context) {
    // Phase 34: daemon-side Brave → DDG fallback chain replaces the
    // Python helper's runtime.exec(python3 websearch.py). API key
    // resolution still honors the helper-era env vars + config field
    // so admin migration is zero-change.
    const apiKey =
      process.env.BRAVE_SEARCH_API_KEY ??
      getConfig().tools.webSearch.braveApiKey ??
      ''

    const max = input.max_results ?? DEFAULT_MAX_RESULTS
    const allowed = (input.allowed_domains ?? []).map((d) => d.toLowerCase())
    const blocked = (input.blocked_domains ?? []).map((d) => d.toLowerCase())

    let results: WebSearchResult[] = []
    try {
      if (apiKey) {
        results = await fetchBraveSearch(apiKey, {
          query: input.query,
          count: max,
          signal: context.abortSignal,
        })
      }
      // Brave returned 0 results OR no key configured → DDG fallback.
      // Mirrors the Python helper at websearch.py:152-155.
      if (results.length === 0) {
        results = await fetchDuckDuckGoSearch({
          query: input.query,
          count: max,
          signal: context.abortSignal,
        })
      }
    } catch (err) {
      return {
        output: `WebSearch failed (exit 1): ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      }
    }

    const filtered = results
      .filter((r) => domainAllowed(r.url, allowed, blocked))
      .slice(0, max)

    const body = renderResults(input.query, filtered)
    return { output: [body, '', REMINDER].join('\n').trim() }
  },
})

/**
 * Apply allow/block domain filter. Matches the Python helper byte-for-byte
 * (websearch.py:32-40): hostname match is exact OR suffix-after-dot
 * (so `example.com` in `allowed` matches both `example.com` and
 * `sub.example.com`). Allowed is a positive list (empty = pass all);
 * blocked is negative.
 */
function domainAllowed(url: string, allowed: string[], blocked: string[]): boolean {
  let host = ''
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }
  if (!host) return false
  if (allowed.length > 0) {
    const matched = allowed.some((d) => host === d || host.endsWith('.' + d))
    if (!matched) return false
  }
  if (blocked.some((d) => host === d || host.endsWith('.' + d))) return false
  return true
}

/**
 * Render results as the Python helper does (websearch.py:124-133): a
 * `# Search results for: <query>` heading, numbered links, snippet
 * indented two spaces below each link. Square brackets in titles get
 * markdown-escaped so `[Foo]` doesn't accidentally render as a link
 * label inside the surrounding `[title](url)` syntax.
 */
function renderResults(query: string, results: WebSearchResult[]): string {
  const lines: string[] = [`# Search results for: ${query}`, '']
  if (results.length === 0) {
    lines.push('No search results found.')
    return lines.join('\n')
  }
  results.forEach((item, i) => {
    const title = item.title.replace(/\[/g, '\\[').replace(/\]/g, '\\]')
    lines.push(`${i + 1}. [${title}](${item.url})`)
    if (item.snippet) {
      lines.push(`   ${item.snippet}`)
    }
  })
  return lines.join('\n')
}
