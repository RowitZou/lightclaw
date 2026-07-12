import { getConfig, type LightClawConfig } from '../../config.js'
import { resolveEffectiveProxy } from '../../provider/proxy.js'
import { registerAuthProvider } from '../index.js'
import { createCodexAuthProvider } from './provider.js'

export { createCodexAuthProvider } from './provider.js'
export {
  CODEX_BACKEND_BASE_URL,
  CODEX_OAUTH_CLIENT_ID,
  CODEX_OAUTH_TOKEN_URL,
  CODEX_REFRESH_SKEW_SECONDS,
} from './constants.js'

/** Resolve the outbound proxy for the GLOBAL codex token-refresh path. The
 *  refresh must route exactly like the codex wire path and the `/admin` /
 *  `/config` login+probe paths: explicit endpoint proxy → deployment
 *  `publicProxy` → direct. The admin codex endpoint can live under ANY alias
 *  (`/admin endpoint add <alias> --type codex ...`), so scan for the
 *  `auth: 'codex-oauth'` shape instead of assuming `endpoints.codex`; when
 *  several carry explicit proxies, the `codex` alias wins for continuity,
 *  else the first declared one. (2026-07-12 family outage: alias `codex-ep`
 *  + publicProxy-only routing made every refresh connect DIRECTLY to
 *  auth.openai.com and time out once the access token expired.) */
export function resolveGlobalCodexProxy(
  config: Pick<LightClawConfig, 'endpoints' | 'publicProxy'>,
): string | undefined {
  const oauthEndpoints = Object.entries(config.endpoints).filter(
    ([, ep]) => 'auth' in ep && ep.auth === 'codex-oauth',
  )
  const explicit =
    oauthEndpoints.find(([alias, ep]) => alias === 'codex' && ep.proxy)?.[1].proxy ??
    oauthEndpoints.find(([, ep]) => ep.proxy)?.[1].proxy
  return resolveEffectiveProxy(explicit, config.publicProxy)
}

/** Idempotent. Called once from `init.ts:initializeApp` so the provider is
 *  always reachable via `getAuthProvider('codex')`. The refresh proxy is
 *  resolved LAZILY at refresh time from the on-disk config (mirroring how
 *  the wire path picks up endpoint/publicProxy edits via provider-cache
 *  flush), so an `/admin proxy` or endpoint change applies to the next
 *  refresh without a daemon restart. The `config` param is the fallback
 *  snapshot when the on-disk config cannot be read (tests, mid-write). */
export function registerCodexAuthProvider(config?: LightClawConfig): void {
  const resolveProxy = (): string | undefined => {
    try {
      return resolveGlobalCodexProxy(getConfig())
    } catch {
      return config ? resolveGlobalCodexProxy(config) : undefined
    }
  }
  registerAuthProvider(createCodexAuthProvider({ proxy: resolveProxy }))
}
