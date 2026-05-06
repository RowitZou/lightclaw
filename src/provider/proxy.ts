import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from 'undici'

// Shared proxy plumbing. Every provider / auth path that needs to reach
// an external endpoint goes through these helpers, fed by an explicit
// `proxy` value from config (endpoint.proxy, channels.feishu.proxy,
// runtime.network.proxy). Nothing here reads ambient `http_proxy` /
// `HTTPS_PROXY` env vars — config is the only source of truth so a
// single endpoint can route through one upstream while another goes
// direct.

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
