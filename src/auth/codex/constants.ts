// OpenAI Codex OAuth constants — source-of-truth values shared with the
// official `@openai/codex` CLI and the Codex VS Code extension. These are
// public client identifiers; a leaked client_id alone has no value because
// the OAuth flow still requires the user to authenticate at
// auth.openai.com.

/** OAuth public client_id used by OpenAI's Codex CLI. We reuse it so
 *  that tokens minted by the official CLI (`codex login`) can be imported
 *  into LightClaw's own store and refreshed there. */
export const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'

/** Token endpoint for refresh_token exchanges. Same auth.openai.com host
 *  used during the initial PKCE flow. */
export const CODEX_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token'

/** OAuth issuer for the Codex device-authorization flow. The device endpoints
 *  live under `{issuer}/api/accounts/deviceauth/*`; the user-facing verify page
 *  is `{issuer}/codex/device`; the final token exchange reuses `{issuer}/oauth/token`
 *  (the same endpoint as `CODEX_OAUTH_TOKEN_URL`). Can be overridden per endpoint
 *  via `endpoint.baseUrl` for private Codex mirrors — mirrors the upstream CLI's
 *  `--issuer` override (`device_code_auth.rs:request_device_code`). */
export const CODEX_OAUTH_ISSUER = 'https://auth.openai.com'

/** Path under `{issuer}/api/accounts` that mints a device user code (step 1). */
export const CODEX_DEVICE_USERCODE_PATH = '/deviceauth/usercode'

/** Path under `{issuer}/api/accounts` polled until the user approves (step 3). */
export const CODEX_DEVICE_TOKEN_PATH = '/deviceauth/token'

/** Path under `{issuer}` of the page where the user enters the user code (step 2). */
export const CODEX_DEVICE_VERIFY_PATH = '/codex/device'

/** `redirect_uri` sent at the final `authorization_code` exchange (step 4). It is
 *  NOT a real callback — the token endpoint only checks it matches what the device
 *  authorization recorded, which is why device flow needs no localhost server.
 *  Path under `{issuer}` (`server.rs:complete_device_code_login`). */
export const CODEX_DEVICE_REDIRECT_PATH = '/deviceauth/callback'

/** Hard ceiling on the device-login poll loop. Matches the upstream CLI's
 *  `max_wait` (`device_code_auth.rs:poll_for_token`) and the server-stamped
 *  `expires_at` window (~15 minutes). */
export const CODEX_DEVICE_MAX_WAIT_MS = 15 * 60 * 1000

/** Default backend base URL for Codex API calls. Provider implementations
 *  may override via endpoint.baseUrl for private mirrors. */
export const CODEX_BACKEND_BASE_URL = 'https://chatgpt.com/backend-api/codex'

/** Number of seconds before stored expiry at which we trigger a refresh.
 *  Matches the official Codex CLI value (and Hermes). */
export const CODEX_REFRESH_SKEW_SECONDS = 120

/** Default location of the official Codex CLI's auth file, used by the
 *  one-time `import()` flow. Honors $CODEX_HOME like the upstream CLI. */
export function codexCliAuthFilePath(): string {
  const codexHome = (process.env.CODEX_HOME?.trim() ?? '').length > 0
    ? process.env.CODEX_HOME!.trim()
    : `${process.env.HOME ?? ''}/.codex`
  return `${codexHome}/auth.json`
}
