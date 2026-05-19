/**
 * Daemon-side HTTP layer for WebFetch / WebSearch.
 *
 * Mirrors Claude Code's `src/tools/WebFetchTool/utils.ts:262-329` shape but
 * with **manual redirect handling + SSRF guard** instead of axios's built-in
 * cross-origin follow. The previous implementation set `maxRedirects:10` and
 * trusted axios to follow blindly — a daemon-side WebFetch that the user
 * approved on hostname `example.com` could 302-chain to:
 *   - cloud metadata IP literals (`169.254.169.254` AWS, `100.100.100.200`
 *     Alibaba, etc.) and read instance credentials;
 *   - internal RFC1918 addresses behind a corp proxy;
 *   - a different public hostname the user never saw / approved.
 * SSRF-like. Permission card and runtime ACLs both gate on the **initial**
 * hostname, not the post-redirect terminal.
 *
 * New behavior:
 *   1. Manual loop, max 10 hops. axios `maxRedirects:0` + custom
 *      validateStatus that accepts 3xx so we see the `Location` header.
 *   2. SSRF hard-block (mode-independent, no opt-out): every hop's
 *      destination URL is checked. If hostname is an IP literal in
 *      private / loopback / link-local ranges → throw `SsrfRedirectError`.
 *      Covers AWS / GCP / Alibaba metadata addresses + RFC1918 + loopback +
 *      IPv6 ULA / link-local.
 *   3. Same-host follow: identical hostname (case-insensitive) → follow.
 *      Cross-host redirect (any hostname change, including same registrable
 *      domain like `docs.foo.com → static.foo.com`) → throw
 *      `CrossHostRedirectError`. The redirect chain is captured so the
 *      caller's tool_result can show the model where the chain wanted to
 *      go; the model can then re-issue `WebFetch(<final-url>)` directly,
 *      which goes through the normal per-hostname permission flow.
 *   4. The guard is **purely in the daemon-fetch layer**: it never calls
 *      `requestPermission()` and never emits a permission card. In auto
 *      (`acceptEdits`) mode the existing policy (`policy.ts:119`) keeps
 *      WebFetch auto-allowed regardless of hostname — the model's
 *      cross-host re-issue under auto mode is still card-free. The card
 *      surface area is unchanged from baseline.
 *
 * Proxy: reuse `runtime.network.proxy` (`NetworkBridgeSettings.proxy`).
 * Semantically WebFetch IS outbound HTTP, just from the daemon process
 * rather than from a sandbox child. Admin sets one proxy; everything
 * routes consistently. The agent injection pattern mirrors
 * `src/channels/feishu/transport-ws.ts:407` — `HttpsProxyAgent` on both
 * `httpAgent` and `httpsAgent`, plus `proxy: false` to disable axios's own
 * URL-string proxy honoring (avoids "proxy of proxy" double-wrap).
 *
 * Out of scope for V1 (acceptable gaps, documented for future hardening):
 *   - DNS resolution of named hosts to catch internal hostnames that
 *     resolve to private IPs. Proxy-fronted environments where the daemon
 *     can't resolve the name but the proxy can complicate the check; the
 *     "any hostname change → tool error" rule already catches the named
 *     internal case (a redirect to `internal.corp` is hostname-different
 *     from `example.com` → tool error).
 *   - Same-registrable-domain follow (e.g. `docs.foo.com → static.foo.com`)
 *     and short-link whitelist (`t.co`, `bit.ly`). Strict same-host is the
 *     safest default; relaxation can land after dogfood shows it's a real
 *     annoyance.
 *   - DNS rebinding defense (pin IP across redirect + body fetch). The
 *     SSRF guard catches the static-IP-literal case which is the high-
 *     value AWS/Alibaba metadata vector; full rebind defense requires
 *     either DNS pinning at the agent layer or per-hop IP capture which
 *     proxies don't expose. Defer.
 */

import { isIP } from 'node:net'

import axios, {
  AxiosError,
  type AxiosResponse,
  type AxiosRequestConfig,
} from 'axios'
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
 *  Beyond this most legitimate redirect chains have looped; we throw
 *  `RedirectLimitError` and the WebFetch tool surfaces it as a clean tool
 *  error so the model can either give up or call a different URL. */
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

/** Error thrown when the redirect destination is an IP literal in a
 *  private / loopback / link-local range. SSRF defense; mode-independent
 *  hard block. */
export class SsrfRedirectError extends Error {
  constructor(
    public readonly redirectChain: string[],
    public readonly blockedUrl: string,
    public readonly reason: string,
  ) {
    super(
      `WebFetch redirect blocked: ${reason} (target ${blockedUrl}, chain: ` +
        `${redirectChain.join(' → ')})`,
    )
    this.name = 'SsrfRedirectError'
  }
}

/** Error thrown when the redirect destination has a different hostname
 *  from the previous hop. The model can re-issue `WebFetch(finalTarget)`
 *  directly — that re-issue goes through the normal per-hostname
 *  permission flow (auto-allowed in `acceptEdits` mode; card in default
 *  mode). The daemon-fetch layer never pops a card itself. */
export class CrossHostRedirectError extends Error {
  constructor(
    public readonly redirectChain: string[],
    public readonly fromHost: string,
    public readonly toUrl: string,
  ) {
    super(
      `WebFetch redirect blocked: cross-host redirect from ${fromHost} to ` +
        `${toUrl}. Re-issue WebFetch with the new URL if intended ` +
        `(chain: ${redirectChain.join(' → ')})`,
    )
    this.name = 'CrossHostRedirectError'
  }
}

/** Error thrown when the redirect chain exceeds MAX_REDIRECTS hops. */
export class RedirectLimitError extends Error {
  constructor(public readonly redirectChain: string[]) {
    super(
      `WebFetch redirect blocked: more than ${MAX_REDIRECTS} hops ` +
        `(chain: ${redirectChain.join(' → ')})`,
    )
    this.name = 'RedirectLimitError'
  }
}

export type DaemonFetchResult = {
  /** Final HTTP status after redirect chain. Always 2xx on success path —
   *  4xx/5xx throw via {@link daemonFetchUrl}. */
  status: number
  /** Final URL after redirect chain. Differs from the input `url` when
   *  same-host redirects (HTTPS upgrade, trailing-slash normalization,
   *  same-host path moves) happened. Used by `web-fetch-filename.ts` to
   *  derive download filenames. */
  finalUrl: string
  /** Raw `Content-Type` header. Lowercase + parameter parsing happens at
   *  caller-side (`web-fetch-extract.ts` / `web-fetch-filename.ts`). */
  contentType: string
  /** Response body bytes after content-encoding decode (gzip/br auto-
   *  decompressed by axios). Capped at MAX_HTTP_CONTENT_LENGTH; oversized
   *  responses throw before reaching here. */
  bytes: Buffer
  /** Same-host redirect chain — the URLs visited from input to terminal,
   *  inclusive. Empty when no redirect happened (single 200 reply).
   *  Length === 1 when input is the same as final and one 3xx hop pointed
   *  back to a same-host path. Surfaced in the tool_result header so the
   *  agent can see HTTPS upgrades / trailing-slash normalization. */
  redirectChain: string[]
}

/**
 * Hard SSRF guard: reject any URL whose hostname is an IP literal in a
 * private / loopback / link-local range, or whose hostname could plausibly
 * be a localhost alias (`localhost`, `*.localhost`). Mode-independent —
 * even in `acceptEdits` mode an attacker-controlled redirect MUST NOT
 * fetch from these targets.
 *
 * Named hosts that resolve to private IPs but aren't IP literals are NOT
 * blocked here (would require DNS resolution; see file header). The
 * cross-host redirect rule catches the typical named-internal case
 * because the hostname will differ from the user-approved initial host.
 *
 * Returns null when the URL is safe; returns the rejection reason string
 * otherwise. Caller wraps in {@link SsrfRedirectError}.
 */
export function classifyRedirectTarget(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return 'unparseable redirect URL'
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `non-HTTP(S) scheme ${parsed.protocol}`
  }
  // Node URL keeps the brackets on IPv6 hostnames (`[fc00::1]`); strip
  // them before isIP / classify. Bare ASCII / IPv4 hostnames are
  // unchanged.
  const rawHost = parsed.hostname.toLowerCase()
  const host = rawHost.startsWith('[') && rawHost.endsWith(']')
    ? rawHost.slice(1, -1)
    : rawHost
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return 'localhost / *.localhost alias'
  }
  const ipKind = isIP(host)
  if (ipKind === 4) {
    return classifyIPv4(host)
  }
  if (ipKind === 6) {
    return classifyIPv6(host)
  }
  return null
}

/** Classify an IPv4 literal. Returns rejection reason or null. */
function classifyIPv4(addr: string): string | null {
  const parts = addr.split('.')
  if (parts.length !== 4) return 'malformed IPv4'
  const octets = parts.map(p => Number.parseInt(p, 10))
  if (octets.some(n => !Number.isFinite(n) || n < 0 || n > 255)) {
    return 'malformed IPv4'
  }
  const [a, b] = octets as [number, number, number, number]
  // 0.0.0.0/8 — "this network" / wildcard. Rejecting this also catches the
  // "0.0.0.0" route-to-loopback trick some kernels still honor.
  if (a === 0) return '0.0.0.0/8 (this network)'
  // 10.0.0.0/8 — RFC1918 private
  if (a === 10) return '10.0.0.0/8 (RFC1918 private)'
  // 100.100.100.200 — Alibaba Cloud metadata. Lives inside the
  // 100.64.0.0/10 CGNAT range but the more specific Alibaba label is
  // useful for admin grep, so check it before the broader CGNAT rule.
  if (addr === '100.100.100.200') {
    return '100.100.100.200 (Alibaba Cloud metadata)'
  }
  // 100.64.0.0/10 — CGNAT shared address space (RFC6598). Used by mobile
  // carrier NATs and some cloud internal service-mesh networks.
  if (a === 100 && b >= 64 && b <= 127) {
    return '100.64.0.0/10 (CGNAT shared address space)'
  }
  // 127.0.0.0/8 — loopback
  if (a === 127) return '127.0.0.0/8 (loopback)'
  // 169.254.0.0/16 — link-local + cloud metadata (AWS / Azure / GCP all
  // use 169.254.169.254 here).
  if (a === 169 && b === 254) {
    return '169.254.0.0/16 (link-local / cloud metadata)'
  }
  // 172.16.0.0/12 — RFC1918 private (172.16.0.0 through 172.31.255.255)
  if (a === 172 && b >= 16 && b <= 31) return '172.16.0.0/12 (RFC1918 private)'
  // 192.168.0.0/16 — RFC1918 private
  if (a === 192 && b === 168) return '192.168.0.0/16 (RFC1918 private)'
  // 192.0.0.0/24 — IANA IPv4 Special Purpose Address Registry (includes
  // 192.0.0.0 dummy, 192.0.0.8 dummy, etc.)
  if (a === 192 && b === 0 && (octets[2] === 0)) {
    return '192.0.0.0/24 (IANA reserved)'
  }
  // 198.18.0.0/15 — benchmarking (RFC2544)
  if (a === 198 && (b === 18 || b === 19)) {
    return '198.18.0.0/15 (RFC2544 benchmarking)'
  }
  return null
}

/** Classify an IPv6 literal. Returns rejection reason or null. */
function classifyIPv6(addr: string): string | null {
  const lower = addr.toLowerCase()
  // ::1 — loopback (also "0:0:0:0:0:0:0:1" expanded form)
  if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') return '::1 (loopback)'
  // ::ffff:a.b.c.d — IPv4-mapped IPv6 in dotted-quad form (rare; some
  // libraries preserve it). Re-classify via the embedded v4.
  const mappedDotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(lower)
  if (mappedDotted) {
    const v4 = mappedDotted[1]!
    const reason = classifyIPv4(v4)
    return reason ? `IPv4-mapped IPv6 → ${reason}` : null
  }
  // ::ffff:HHHH:HHHH — Node's URL canonical form for IPv4-mapped IPv6
  // (e.g. `[::ffff:169.254.169.254]` normalizes to `::ffff:a9fe:a9fe`).
  // Decode the last 32 bits into dotted-quad and reuse the v4 classifier.
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower)
  if (mappedHex) {
    const hi = Number.parseInt(mappedHex[1]!, 16)
    const lo = Number.parseInt(mappedHex[2]!, 16)
    const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`
    const reason = classifyIPv4(v4)
    return reason ? `IPv4-mapped IPv6 → ${reason}` : null
  }
  // fc00::/7 — Unique Local Addresses (ULA), the IPv6 analog of RFC1918.
  // First byte is fc or fd.
  if (lower.startsWith('fc') || lower.startsWith('fd')) {
    // Confirm leading byte high bit; 'fc' = 0xfc, 'fd' = 0xfd, both in
    // fc00::/7. Reject anything starting fc.. or fd.. before a colon.
    const firstSegment = lower.split(':')[0] ?? ''
    if (firstSegment.length <= 4 && /^f[cd][0-9a-f]{0,2}$/.test(firstSegment)) {
      return 'fc00::/7 (IPv6 ULA private)'
    }
  }
  // fe80::/10 — link-local
  if (lower.startsWith('fe8') || lower.startsWith('fe9') ||
      lower.startsWith('fea') || lower.startsWith('feb')) {
    const firstSegment = lower.split(':')[0] ?? ''
    if (firstSegment.length <= 4 && /^fe[89ab][0-9a-f]{0,2}$/.test(firstSegment)) {
      return 'fe80::/10 (IPv6 link-local)'
    }
  }
  return null
}

/**
 * Single-shot HTTP GET with manual redirect handling, SSRF guard, browser
 * UA, and proxy routing. Returns the full response body as Buffer — caller
 * decides binary vs text path via `isBinaryContentType(contentType)`.
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
 * On SSRF / cross-host / max-hop redirect violations throws the
 * corresponding error class above; the WebFetch tool catches it and
 * surfaces the chain to the model so it can decide whether to re-issue
 * on the new URL.
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
 *   forwards its own `timeoutMs` here. Applied **per hop** — a 10-hop
 *   chain that times out hop 5 throws after `5 * timeoutMs` worst case,
 *   matching axios's prior per-hop semantics under maxRedirects:10.
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

  let currentUrl = url
  let initialHost: string
  try {
    initialHost = new URL(url).hostname.toLowerCase()
  } catch {
    throw new Error(`WebFetch: invalid URL ${url}`)
  }

  // Walk the redirect chain manually. axios sees `maxRedirects:0` per
  // request, and validateStatus accepts 3xx so the response surfaces
  // instead of throwing. Each iteration either:
  //   - 2xx → return the body
  //   - 3xx → validate Location, advance currentUrl, continue
  //   - 4xx/5xx → axios throws via its own default validateStatus (we
  //     widened to accept 3xx but kept 4xx/5xx as errors)
  const redirectChain: string[] = []
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    // Retry transient network failures (socket reset / TLS-handshake abort —
    // the 2026-05-14 proxy-blip dogfood — plus upstream 502/503/504, which
    // axios's default validateStatus surfaces as AxiosError with
    // `.response.status`). 4xx, axios timeout (ECONNABORTED), and abort are
    // NOT retried; see web-retry.ts.
    const response = await withWebRetry(
      () =>
        httpGetFn<ArrayBuffer>(currentUrl, {
          signal,
          timeout: timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
          maxRedirects: 0,
          maxContentLength: MAX_HTTP_CONTENT_LENGTH,
          responseType: 'arraybuffer',
          headers: BROWSER_HEADERS,
          httpAgent: agent,
          httpsAgent: agent,
          proxy: false,
          decompress: true,
          // Accept 3xx so we can read the Location header ourselves.
          // 4xx/5xx still throw via axios default error path so the
          // WebFetch tool envelope catches them.
          validateStatus: status =>
            (status >= 200 && status < 300) || (status >= 300 && status < 400),
        }),
      { label: 'WebFetch', signal },
    )

    if (response.status >= 200 && response.status < 300) {
      const contentTypeHeader = response.headers['content-type']
      const contentType =
        typeof contentTypeHeader === 'string'
          ? contentTypeHeader
          : Array.isArray(contentTypeHeader)
            ? contentTypeHeader[0] ?? ''
            : ''
      return {
        status: response.status,
        finalUrl: currentUrl,
        contentType,
        bytes: Buffer.from(response.data),
        redirectChain,
      }
    }

    // 3xx — read Location, validate, advance.
    const locationHeader = response.headers.location
    const location =
      typeof locationHeader === 'string'
        ? locationHeader
        : Array.isArray(locationHeader)
          ? locationHeader[0]
          : undefined
    if (!location) {
      // 3xx without Location is malformed; throw the same axios-style
      // message the WebFetch envelope expects.
      throw new AxiosError(
        `HTTP ${response.status} missing Location header at ${currentUrl}`,
      )
    }
    let nextUrl: string
    try {
      nextUrl = new URL(location, currentUrl).toString()
    } catch {
      throw new AxiosError(
        `HTTP ${response.status} malformed Location ${location} at ${currentUrl}`,
      )
    }

    // Build the chain entry BEFORE the safety checks so SSRF / cross-host
    // errors include the attempted target in the chain for forensics.
    redirectChain.push(nextUrl)

    // SSRF hard-block — mode-independent.
    const ssrfReason = classifyRedirectTarget(nextUrl)
    if (ssrfReason) {
      throw new SsrfRedirectError([url, ...redirectChain], nextUrl, ssrfReason)
    }

    // Cross-host check. Same hostname (case-insensitive) → follow.
    const nextHost = new URL(nextUrl).hostname.toLowerCase()
    const currentHost = new URL(currentUrl).hostname.toLowerCase()
    if (nextHost !== currentHost) {
      // Strict same-host rule. The initial hostname (initialHost) is what
      // permission gated on; any host change is suspicious. The model
      // should re-issue WebFetch on the new URL so its hostname goes
      // through the normal permission flow.
      throw new CrossHostRedirectError(
        [url, ...redirectChain.slice(0, -1)],
        currentHost,
        nextUrl,
      )
    }

    currentUrl = nextUrl
  }

  // Fell out of the loop without returning → exceeded MAX_REDIRECTS.
  throw new RedirectLimitError([url, ...redirectChain])
}

/** Re-export for tests that need to assert on the initial-host comparison
 *  semantics directly. Public surface deliberately narrow — callers should
 *  go through {@link daemonFetchUrl}. */
export const _internalsForTests = {
  classifyRedirectTarget,
  MAX_REDIRECTS,
}
