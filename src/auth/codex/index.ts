import { registerAuthProvider } from '../index.js'
import { createCodexAuthProvider } from './provider.js'

export { createCodexAuthProvider } from './provider.js'
export {
  CODEX_BACKEND_BASE_URL,
  CODEX_OAUTH_CLIENT_ID,
  CODEX_OAUTH_TOKEN_URL,
  CODEX_REFRESH_SKEW_SECONDS,
} from './constants.js'

/** Idempotent. Called once from `init.ts:initializeApp` so the provider is
 *  always reachable via `getAuthProvider('codex')`. */
export function registerCodexAuthProvider(): void {
  registerAuthProvider(createCodexAuthProvider())
}
