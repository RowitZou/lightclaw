/**
 * DuckDuckGo HTML scrape fallback for daemon-side WebSearch.
 *
 * DDG's `/html/` endpoint is a server-rendered Lite HTML page — no API,
 * no JSON, just regex matching against `<a class="result__a">` and
 * `<a class="result__snippet">` blocks. Fragile but it's the only
 * no-key search backend we have; users without a Brave API key fall
 * back to this.
 *
 * Two subtle things from the Python helper preserved here:
 *  1. DDG's `result__a` `href` is a redirect URL like
 *     `//duckduckgo.com/l/?uddg=<real>&...` — the real URL is in the
 *     `uddg` query param. Always extract that, never the raw href.
 *  2. The endpoint sniffs UA and serves a captcha / "anomaly" page if
 *     the request looks like a bot. A current Chrome UA on Linux
 *     consistently routes to the regular Lite HTML page. Mirror the
 *     Python helper's BROWSER_HEADERS verbatim.
 */

import axios from 'axios'
import { HttpsProxyAgent } from 'https-proxy-agent'

import { getConfig } from '../config.js'
import type { WebSearchResult } from './web-search-brave.js'
import { withWebRetry } from './web-retry.js'

const DDG_ENDPOINT = 'https://duckduckgo.com/html/'

/** 10 s — the DDG html endpoint answers in 1-3 s when healthy; a request
 *  still silent at 10 s is effectively dead. The old 30 s budget turned a
 *  hung request into 30 s of user-visible stall (2026-07-26 dogfood: two
 *  such stalls in one research worker), and axios timeouts are deliberately
 *  not retried by withWebRetry, so the full budget is always burned. */
const DDG_TIMEOUT_MS = 10_000

const DDG_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/131.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
}

/** Injectable axios.get for unit tests, same DI shim shape as Brave. */
type AxiosGetLike = typeof axios.get
let httpGetFn: AxiosGetLike = axios.get
export function _setDdgHttpGetForTests(fn: AxiosGetLike | null): void {
  httpGetFn = fn ?? axios.get
}

/**
 * Minimal HTML entity decode covering the entities DDG actually produces
 * in titles / snippets: numeric, hex numeric, and the 5 common named
 * entities. Full `entities` library not needed — DDG's HTML is conservative,
 * and a missed entity is at worst a visual `&foo;` in the model's view.
 * Mirrors Python `html.unescape()` for the actual subset DDG uses.
 */
function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
}

/** Strip HTML tags from a captured fragment (DDG embeds `<b>` highlights
 *  in titles + snippets — we want the plain text). Mirrors Python
 *  `re.sub(r"<.*?>", "", s, flags=re.S)`. */
function stripTags(s: string): string {
  return s.replace(/<.*?>/gs, '')
}

/**
 * Single DDG HTML scrape. Always 200 (DDG never errors on the Lite endpoint
 * — bot-detect failures return a captcha page that the regex won't match
 * and we return an empty array). Caller (web-search.ts) routes empty
 * arrays as "no result" rather than as fallback signal.
 */
export async function fetchDuckDuckGoSearch(input: {
  query: string
  count: number
  signal: AbortSignal
}): Promise<WebSearchResult[]> {
  const proxy = getConfig().runtime.network.proxy
  const agent = proxy ? new HttpsProxyAgent(proxy) : undefined

  // Retry only the scrape round-trip — DDG's Lite endpoint always 200s, so
  // there is no status-code branch here; the retry covers socket-level
  // proxy blips (2026-05-14 dogfood). HTML parsing below is deterministic
  // and stays outside the retry.
  const response = await withWebRetry(
    () =>
      httpGetFn(DDG_ENDPOINT, {
        signal: input.signal,
        timeout: DDG_TIMEOUT_MS,
        httpAgent: agent,
        httpsAgent: agent,
        proxy: false,
        headers: DDG_HEADERS,
        params: { q: input.query },
        responseType: 'text',
      }),
    { label: 'WebSearch/ddg', signal: input.signal },
  )
  const text = typeof response.data === 'string' ? response.data : String(response.data ?? '')

  // result__a href + title (s flag = DOTALL because titles can span lines)
  const blockRe = /<a rel="nofollow" class="result__a" href="(.*?)">(.*?)<\/a>/gs
  const snippetRe = /<a class="result__snippet".*?>(.*?)<\/a>/gs

  const blocks = [...text.matchAll(blockRe)]
  const snippets = [...text.matchAll(snippetRe)]

  const out: WebSearchResult[] = []
  for (let i = 0; i < Math.min(blocks.length, input.count); i += 1) {
    const m = blocks[i]
    if (!m) continue
    const rawHref = decodeHtmlEntities(m[1] ?? '')
    const rawTitleHtml = m[2] ?? ''

    // DDG wraps real URLs in a `/l/?uddg=<real>` redirect. Parse it
    // and pull `uddg`; if absent (some older shapes / direct hrefs),
    // fall back to the raw href.
    let url = rawHref
    try {
      const parsed = new URL(rawHref, DDG_ENDPOINT)
      const uddg = parsed.searchParams.get('uddg')
      if (uddg) url = uddg
    } catch {
      // rawHref isn't a valid URL — keep as-is and let downstream
      // domain filter / model see the unusable string. Unlikely path
      // (DDG always emits absolute or path-relative URLs).
    }

    const titleText = decodeHtmlEntities(stripTags(rawTitleHtml)).trim() || 'Untitled'
    const snippetMatch = snippets[i]
    const snippetText = snippetMatch
      ? decodeHtmlEntities(stripTags(snippetMatch[1] ?? '')).trim()
      : ''

    out.push({ title: titleText, url, snippet: snippetText })
  }
  return out
}
