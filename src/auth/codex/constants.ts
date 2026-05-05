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
