/**
 * Brave Web Search v1 provider for daemon-side WebSearch.
 *
 * Mirrors OpenClaw's `extensions/brave/src/brave-web-search-provider.runtime.ts`
 * shape (header auth, q/count params, `response.web.results[]` → flat
 * `{title, url, snippet}` mapping). Two deliberate divergences from
 * OpenClaw:
 *
 *  1. **Error transparency over collapse**. OpenClaw + Hermes both
 *     collapse all non-200 statuses into a single error envelope.
 *     LightClaw users have repeatedly fed back "诊断信息缺失" (Bug 9 /
 *     Bug 10 dogfood) — so on non-200 we throw with full
 *     `${status} ${statusText}; body=${first 400 chars}` so admin grep
 *     sees the Brave `code` / `msg` (e.g. `QUOTA_EXCEEDED`, `BAD_KEY`).
 *  2. **No client-side cache**. OpenClaw caches under
 *     `[mode, baseUrl, q, country, search_lang, freshness]` key. V1
 *     LightClaw skips this — caching needs cache-eviction reasoning
 *     and a TTL story that we'd just guess at without dogfood data.
 *     Add when users report "重复搜同样 query 浪费 quota".
 *
 * Endpoint / auth / params are fixed at V1 (OpenClaw exposes baseUrl
 * override + `country` / `search_lang` / `freshness` config knobs —
 * LightClaw V1 doesn't need them yet, but the shape stays additive-
 * friendly should a future Phase wire them in).
 */

import axios from 'axios'
import { HttpsProxyAgent } from 'https-proxy-agent'

import { getConfig } from '../config.js'
import {
  isRetryableHttpStatus,
  WebRetryableHttpError,
  withWebRetry,
} from './web-retry.js'

const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search'

/** 30 s — Brave's API is typically < 1 s but slow upstream blips happen.
 *  Tighter than WebFetch's 60 s because search is interactive and a long
 *  hang feels worse than a timeout. */
const BRAVE_TIMEOUT_MS = 30_000

export type WebSearchResult = {
  /** Title from Brave's `web.results[i].title` (or `.name` fallback for
   *  older response shapes). Defaults to 'Untitled' if neither field
   *  present — mirrors websearch.py:80. */
  title: string
  /** URL from `web.results[i].url` (or `.link` fallback). Empty-string
   *  results are filtered out by the caller. */
  url: string
  /** Description from `.description` (or `.snippet` fallback). May be
   *  empty string when Brave returns no rich snippet. */
  snippet: string
}

export type BraveProviderInput = {
  /** Search query (validated upstream at Zod schema layer to be ≥ 2 chars). */
  query: string
  /** Max results to fetch from Brave. Brave's `count` param caps at 20
   *  per the API docs; we forward verbatim and let Brave do the upper
   *  bound check rather than reimplementing it here. */
  count: number
  signal: AbortSignal
}

/**
 * Injectable axios.get for unit tests. Same DI shim shape as
 * `_setHttpGetForTests` in web-fetch-http.ts. Tests reset to null in
 * afterEach to restore the real axios.
 */
type AxiosGetLike = typeof axios.get
let httpGetFn: AxiosGetLike = axios.get
export function _setBraveHttpGetForTests(fn: AxiosGetLike | null): void {
  httpGetFn = fn ?? axios.get
}

/**
 * Single Brave Search round-trip. Throws on non-200 status with the
 * full body for admin grep; resolves to a (possibly empty) result
 * array on 200. Callers (web-search.ts) handle the empty-array case
 * by falling back to DDG.
 *
 * The `apiKey` arg is intentionally required — caller decides whether
 * to invoke at all based on key presence (matches the Python helper's
 * `if api_key:` gate in websearch.py:48-52).
 */
export async function fetchBraveSearch(
  apiKey: string,
  input: BraveProviderInput,
): Promise<WebSearchResult[]> {
  const proxy = getConfig().runtime.network.proxy
  const agent = proxy ? new HttpsProxyAgent(proxy) : undefined

  // Retry the round-trip + status check together. A transient proxy blip
  // (the 2026-05-14 socket-disconnect dogfood) throws from axios and is
  // re-sent; a 502/503/504 from Brave is re-sent via WebRetryableHttpError.
  // 401 BAD_KEY / 429 QUOTA_EXCEEDED throw a plain Error the retry
  // predicate ignores, so they stay fast-fail with the body for admin
  // grep. Response *parsing* below is deterministic and stays outside the
  // retry so a re-send never re-runs it.
  const response = await withWebRetry(
    async () => {
      const res = await httpGetFn(BRAVE_ENDPOINT, {
        signal: input.signal,
        timeout: BRAVE_TIMEOUT_MS,
        httpAgent: agent,
        httpsAgent: agent,
        proxy: false,
        headers: {
          Accept: 'application/json',
          'X-Subscription-Token': apiKey,
          'User-Agent': 'LightClaw-WebSearch/0.1',
        },
        params: { q: input.query, count: input.count },
        validateStatus: () => true,
      })
      if (res.status !== 200) {
        const bodyStr =
          typeof res.data === 'string' ? res.data : JSON.stringify(res.data)
        const message =
          `Brave Search API error ${res.status} ${res.statusText}; ` +
          `body=${bodyStr.slice(0, 400)}`
        if (isRetryableHttpStatus(res.status)) {
          throw new WebRetryableHttpError(res.status, message)
        }
        throw new Error(message)
      }
      return res
    },
    { label: 'WebSearch/brave', signal: input.signal },
  )

  // Brave's response shape (as of 2026-05): `{web: {results: [...]}, ...}`.
  // Older / alternate self-hosted proxies sometimes return a flat `results`
  // — mirror that fallback shape from OpenClaw runtime.ts:320 + the Python
  // helper at websearch.py:71-75.
  const data = response.data as
    | { web?: { results?: unknown[] }; results?: unknown[] }
    | undefined
  const rawResults: unknown[] = data?.web?.results ?? data?.results ?? []

  return rawResults
    .slice(0, input.count)
    .map((item): WebSearchResult | null => {
      if (typeof item !== 'object' || item === null) return null
      const r = item as Record<string, unknown>
      const url =
        typeof r.url === 'string' && r.url
          ? r.url
          : typeof r.link === 'string'
            ? r.link
            : ''
      if (!url) return null  // filter out malformed entries with no URL
      return {
        title:
          typeof r.title === 'string' && r.title
            ? r.title
            : typeof r.name === 'string' && r.name
              ? r.name
              : 'Untitled',
        url,
        snippet:
          typeof r.description === 'string'
            ? r.description
            : typeof r.snippet === 'string'
              ? r.snippet
              : '',
      }
    })
    .filter((r): r is WebSearchResult => r !== null)
}
