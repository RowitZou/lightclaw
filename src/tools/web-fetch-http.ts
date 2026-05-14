/**
 * Daemon-side HTTP layer for WebFetch / WebSearch.
 *
 * Mirrors Claude Code's `src/tools/WebFetchTool/utils.ts:262-329` shape but
 * trades the per-hop same-origin redirect policy (an enterprise SSRF guard
 * Claude Code carries) for axios's built-in cross-origin redirect follow.
 * LightClaw's permission system already gates WebFetch by hostname, and the
 * Phase 33 runtime model treats outbound HTTP as out-of-scope-for-sandbox —
 * `t.co` / `bit.ly` / CDN cross-host redirects are dogfood-common and
 * blocking them is a worse default than allowing them.
 *
 * Proxy: reuse `runtime.network.proxy` (`NetworkBridgeSettings.proxy`).
 * Semantically WebFetch IS outbound HTTP, just from the daemon process
 * rather than from a sandbox child. Admin sets one proxy; everything
 * routes consistently. The agent injection pattern mirrors
 * `src/channels/feishu/transport-ws.ts:407` — `HttpsProxyAgent` on both
 * `httpAgent` and `httpsAgent`, plus `proxy: false` to disable axios's own
 * URL-string proxy honoring (avoids "proxy of proxy" double-wrap).
 */

import axios, { type AxiosResponse, type AxiosRequestConfig } from 'axios'
import { HttpsProxyAgent } from 'https-proxy-agent'

import { getConfig } from '../config.js'
import { withWebRetry } from './web-retry.js'

/** Injectable axios.get for unit tests of the HTTP layer itself. The DI
 *  shim mirrors `_setWebFetchSummarizerForTests` in web-fetch.ts — both
 *  replace a module-level callable so tests can run against stubbed
 *  transport without touching the real network. Tests reset to null in
 *  afterEach to restore the real axios. */
type AxiosGetLike = <T = unknown>(
  url: string,
  config?: AxiosRequestConfig,
) => Promise<AxiosResponse<T>>
let httpGetFn: AxiosGetLike = (url, config) => axios.get(url, config)
export function _setHttpGetForTests(fn: AxiosGetLike | null): void {
  httpGetFn = fn ?? ((url, config) => axios.get(url, config))
}

/** Higher-level injection for callers of daemonFetchUrl (e.g. web-fetch.ts'
 *  tool tests). Skips the axios shape entirely so tests can return the
 *  shape they care about (bytes / contentType / finalUrl) without forging
 *  an AxiosResponse. The same null-reset pattern restores real fetch. */
type DaemonFetchFn = (
  url: string,
  signal: AbortSignal,
  timeoutMs?: number,
) => Promise<DaemonFetchResult>
let daemonFetchFn: DaemonFetchFn | null = null
export function _setDaemonFetchUrlForTests(fn: DaemonFetchFn | null): void {
  daemonFetchFn = fn
}

/** 10 MB cap on raw response body, Claude Code-aligned
 *  (`utils.ts:112 MAX_HTTP_CONTENT_LENGTH`). Axios drops responses larger
 *  than this with an error — we'd rather fail loudly than silently truncate
 *  binary downloads. The cap is sized for typical web content (HTML pages
 *  < 1 MB, PDFs < 5 MB); larger artifacts (datasets, models) belong in
 *  Bash + curl with explicit user intent. */
const MAX_HTTP_CONTENT_LENGTH = 10 * 1024 * 1024

/** 60 s default fetch timeout, Claude Code-aligned (`utils.ts:116`).
 *  Caller-overridable via `timeoutMs` param. Schema cap in
 *  `web-fetch.ts` is 120 s, default 35 s — the daemon HTTP layer accepts
 *  the higher ceiling and lets the tool's own schema enforce its
 *  preferred default. */
const DEFAULT_FETCH_TIMEOUT_MS = 60_000

/** 10 hops cap on redirect chain, Claude Code-aligned (`utils.ts:125`).
 *  Beyond this most legitimate redirect chains have looped; axios throws
 *  `ERR_FR_TOO_MANY_REDIRECTS`. We surface that as a user-readable error
 *  rather than a generic axios noise. */
const MAX_REDIRECTS = 10

/** Browser UA so Cloudflare / Akamai / Distill don't 403 us as
 *  `axios/x.y.z`. Mirrors the Python helper's BROWSER_USER_AGENT —
 *  pretending to be Chrome on Linux is a calibrated lie: tells the
 *  CDN we render HTML, accept compression, etc. */
const BROWSER_HEADERS = {
  Accept:
    'text/markdown,text/html,application/xhtml+xml,application/xml;q=0.9,' +
    'application/rss+xml;q=0.9,application/atom+xml;q=0.9,' +
    'application/json;q=0.9,' +
    'application/pdf;q=0.9,' +
    'image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/131.0.0.0 Safari/537.36',
}

export type DaemonFetchResult = {
  /** Final HTTP status after redirect chain. Always 2xx on success path —
   *  4xx/5xx throw via {@link daemonFetchUrl}. */
  status: number
  /** Final URL after redirect chain. Differs from the input `url` when
   *  HTTPS upgrade or hostname redirects happened. Used by
   *  `web-fetch-filename.ts` to derive download filenames. */
  finalUrl: string
  /** Raw `Content-Type` header. Lowercase + parameter parsing happens at
   *  caller-side (`web-fetch-extract.ts` / `web-fetch-filename.ts`). */
  contentType: string
  /** Response body bytes after content-encoding decode (gzip/br auto-
   *  decompressed by axios). Capped at MAX_HTTP_CONTENT_LENGTH; oversized
   *  responses throw before reaching here. */
  bytes: Buffer
}

/**
 * Single-shot HTTP GET with 10-redirect follow, browser UA, and proxy
 * routing. Returns the full response body as Buffer — caller decides
 * binary vs text path via `isBinaryContentType(contentType)`.
 *
 * On 4xx/5xx status throws `HTTP <status> <statusText>` (the message that
 * the WebFetch tool wraps into its `WebFetch failed (exit 1): fetch
 * failed: <err.message>` envelope, preserving the Python helper's stderr
 * format byte-for-byte for stable LLM-side parsing).
 *
 * On network errors throws axios's native message (`ECONNREFUSED`,
 * `timeout of Xms exceeded`, etc.) — the type name is useful for admin
 * grep and the same WebFetch envelope wraps it.
 *
 * @param url Full HTTP(S) URL. Caller is expected to have validated via
 *   Zod / `URL` constructor; we don't re-validate here to keep the layer
 *   thin and testable in isolation.
 * @param signal Abort signal from the tool call context. Propagates to
 *   axios via the standard `signal` option — abort during connect or
 *   read throws `CanceledError` which axios surfaces under its standard
 *   message; the WebFetch envelope handles it the same as any throw.
 * @param timeoutMs Optional override; defaults to
 *   {@link DEFAULT_FETCH_TIMEOUT_MS} (60 s). The WebFetch tool schema
 *   forwards its own `timeoutMs` here.
 */
export async function daemonFetchUrl(
  url: string,
  signal: AbortSignal,
  timeoutMs?: number,
): Promise<DaemonFetchResult> {
  if (daemonFetchFn) return daemonFetchFn(url, signal, timeoutMs)
  const proxy = getConfig().runtime.network.proxy
  // Same agent on both http and https so a single proxy URL covers both;
  // matches feishu/transport-ws.ts:407. `proxy: false` disables axios's
  // own `process.env.http_proxy` honoring — Phase 33 invariant: ambient
  // env never leaks into outbound HTTP, only the explicit config knob.
  const agent = proxy ? new HttpsProxyAgent(proxy) : undefined

  // Retry transient network failures (socket reset / TLS-handshake abort —
  // the 2026-05-14 proxy-blip dogfood — plus upstream 502/503/504, which
  // axios's default validateStatus surfaces as AxiosError with
  // `.response.status`). 4xx, axios timeout (ECONNABORTED), and abort are
  // NOT retried; see web-retry.ts. The redirect / status / size handling
  // below is unchanged — withWebRetry only re-sends the GET.
  const response = await withWebRetry(
    () =>
      httpGetFn<ArrayBuffer>(url, {
        signal,
        timeout: timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
        maxRedirects: MAX_REDIRECTS,
        maxContentLength: MAX_HTTP_CONTENT_LENGTH,
        responseType: 'arraybuffer',
        headers: BROWSER_HEADERS,
        httpAgent: agent,
        httpsAgent: agent,
        proxy: false,
        decompress: true,
        // We want to surface every non-2xx as a thrown error with a clean
        // `HTTP <status>` message — `validateStatus: () => true` would force
        // us to test the response ourselves, but axios's default
        // (`status >= 200 && status < 300`) already does the right thing
        // with a more informative AxiosError. Stick with default.
      }),
    { label: 'WebFetch', signal },
  )

  const contentTypeHeader = response.headers['content-type']
  const contentType =
    typeof contentTypeHeader === 'string'
      ? contentTypeHeader
      : Array.isArray(contentTypeHeader)
        ? contentTypeHeader[0] ?? ''
        : ''

  // axios sets `response.request.res.responseUrl` to the final URL after
  // redirects (Node http adapter). Browser builds don't set it, but
  // LightClaw daemon is always Node — defensive `?? url` fallback for
  // mocks / non-redirect cases.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const finalUrl: string = (response as any)?.request?.res?.responseUrl ?? url

  return {
    status: response.status,
    finalUrl,
    contentType,
    bytes: Buffer.from(response.data),
  }
}
