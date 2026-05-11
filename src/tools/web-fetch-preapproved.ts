/**
 * Domains where WebFetch can skip the sub-LLM summarize step and return raw
 * markdown to the main model directly. Criteria (mirrors CC's preapproved):
 * - Stable, well-structured documentation (server-rendered markdown / HTML
 *   that converts cleanly via trafilatura).
 * - Frequently visited by coding assistants, so summarize cost would be a
 *   recurring tax.
 * - Public, no auth wall, no anti-scraping that changes content per fetch.
 *
 * V1 starts intentionally narrow (~10 entries). Admin can extend in a follow-up
 * patch as dogfood reveals more recurring fetch targets.
 */
const PREAPPROVED_DOMAINS: ReadonlySet<string> = new Set([
  'docs.python.org',
  'nodejs.org',
  'www.typescriptlang.org',
  'react.dev',
  'nextjs.org',
  'fastapi.tiangolo.com',
  'developer.mozilla.org',
  'docs.anthropic.com',
  'platform.openai.com',
  'pkg.go.dev',
])

export function isPreapprovedUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return PREAPPROVED_DOMAINS.has(parsed.hostname)
  } catch {
    return false
  }
}
