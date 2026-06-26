import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from 'undici'

// Shared proxy plumbing. Every provider / auth path that needs to reach
// an external endpoint goes through these helpers, fed by an explicit
// `proxy` value from config (endpoint.proxy, channels.feishu.proxy,
// runtime.network.proxy). Nothing here reads ambient `http_proxy` /
// `HTTPS_PROXY` env vars — config is the only source of truth so a
// single endpoint can route through one upstream while another goes
// direct.

/** Resolve the effective outbound proxy for an endpoint, applying the
 *  deployment-wide public-proxy fallback. Precedence:
 *    explicit per-endpoint proxy  ->  public (deployment) proxy  ->  direct.
 *  Empty / whitespace strings count as unset at each tier. This is the single
 *  precedence rule shared by the provider wire path (`getProviderFor`) and the
 *  endpoint-add connectivity probe, so a user who configures an endpoint
 *  without `--proxy` transparently routes through the admin's public proxy
 *  (and falls back to direct when no public proxy is set). */
export function resolveEffectiveProxy(
  explicit: string | undefined | null,
  publicProxy: string | undefined | null,
): string | undefined {
  const e = explicit?.trim()
  if (e) return e
  const p = publicProxy?.trim()
  if (p) return p
  return undefined
}

/** Build an undici dispatcher for the given proxy URL. Returns
 *  `undefined` when proxy is unset / invalid, signaling "direct
 *  connection". Callers should pass the dispatcher through to
 *  `undici.request` / `undici.fetch` only when defined. */
export function buildProxyDispatcher(proxy: string | undefined | null): Dispatcher | undefined {
  if (!proxy) return undefined
  const trimmed = proxy.trim()
  if (!trimmed) return undefined
  try {
    return new ProxyAgent(trimmed)
  } catch {
    return undefined
  }
}

/** Wrap an undici dispatcher into a `globalThis.fetch`-compatible
 *  function so SDKs that take a custom `fetch` (Anthropic / OpenAI) can
 *  route through the proxy. Returns `undefined` when no dispatcher —
 *  callers should then fall through to the SDK's built-in fetch (which
 *  is also undici, just without a dispatcher = direct connection). */
export function buildProxyAwareFetch(
  dispatcher: Dispatcher | undefined,
): typeof globalThis.fetch | undefined {
  if (!dispatcher) return undefined
  return ((url: string | URL | Request, init?: RequestInit) =>
    undiciFetch(url as never, {
      ...(init ?? {}),
      dispatcher,
    } as never) as unknown as Promise<Response>) as typeof globalThis.fetch
}
