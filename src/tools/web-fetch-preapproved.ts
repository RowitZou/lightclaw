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
const BUILTIN_PREAPPROVED_DOMAINS: ReadonlySet<string> = new Set([
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

/** Returns true if `url`'s hostname is in the built-in baseline or in
 *  the admin-supplied `extras` list (typically `config.tools.webFetch.preapprovedDomains`).
 *  Match is exact hostname; subdomain wildcards are not supported in V1 —
 *  admin must list each FQDN explicitly. Invalid URL strings return false
 *  (the helper will surface the real error downstream).
 *
 *  `extras` is merged with — not replacing — the built-in list. Admin cannot
 *  remove built-in entries via config; if a built-in entry becomes
 *  problematic (e.g. site changes ownership), edit BUILTIN_PREAPPROVED_DOMAINS
 *  and ship a patch. */
export function isPreapprovedUrl(url: string, extras: readonly string[] = []): boolean {
  try {
    const hostname = new URL(url).hostname
    if (BUILTIN_PREAPPROVED_DOMAINS.has(hostname)) return true
    for (const entry of extras) {
      if (entry === hostname) return true
    }
    return false
  } catch {
    return false
  }
}
