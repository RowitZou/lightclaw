// AuthProvider abstraction for OAuth-style credentials. First implementation
// is Codex (`src/auth/codex/`); future Copilot / Gemini OAuth providers
// register against the same interface.
//
// Storage layout: each provider owns one file at
// `<lightclawHome>/auth/<provider.name>.json`. The shape of the JSON body
// is provider-specific; only the storage helpers in `./storage.ts` know
// the on-disk format. Callers consume `AuthCredentials` from
// `getCredentials()` and never touch the file directly.

/** Live credential bundle returned by `AuthProvider.getCredentials()`.
 *  The provider has already refreshed if the stored access token was within
 *  its refresh skew. */
export type AuthCredentials = {
  /** Bearer token sent to the backend. */
  accessToken: string
  /** Unix epoch ms. The provider refreshes when (now + skewMs) >= expiresAt. */
  expiresAt: number
  /**
   * Provider-specific identifier.
   * - For Codex: the `auth.account_id` claim from the JWT, sent as
   *   `chatgpt-account-id` header. Required by the Codex backend.
   * - Other providers may leave this empty.
   */
  accountId: string
}

export type AuthErrorCode =
  /** No token file at `<home>/auth/<provider>.json`. */
  | 'auth_missing'
  /** Token file present but missing required fields. */
  | 'tokens_invalid_shape'
  /** Imported token already past expiry. */
  | 'tokens_expired'
  /** Generic 4xx/5xx from the token endpoint. */
  | 'refresh_failed'
  /** OpenAI returned `invalid_grant` — the refresh_token was rotated by
   *  another client (Codex CLI / VS Code ext). User must re-login from the
   *  source CLI. */
  | 'refresh_consumed_by_other_client'
  /** Provider name passed to a registry lookup is not registered. */
  | 'unknown_provider'

export class AuthError extends Error {
  readonly code: AuthErrorCode
  readonly provider: string

  constructor(opts: { code: AuthErrorCode; provider: string; message: string }) {
    super(opts.message)
    this.name = 'AuthError'
    this.code = opts.code
    this.provider = opts.provider
  }
}

export type AuthProvider = {
  /** Stable identifier; also the file basename in `<home>/auth/<name>.json`. */
  name: string

  /**
   * Resolve runtime credentials. Reads stored tokens, checks expiry against
   * the provider's refresh skew, calls refresh if needed, persists the
   * refreshed tokens, and returns the live access bundle.
   *
   * `forceRefresh` skips the local expiry check and refreshes unconditionally.
   * The wire caller uses it after a 401 on a locally-"valid" access token —
   * server-side revocation (another client's login rotated the family) is
   * invisible to the expiry clock, so the 401 itself is the staleness signal.
   *
   * Throws `AuthError` for missing / invalid / unrefreshable state. The
   * caller surfaces the message to the operator.
   */
  getCredentials(opts?: { forceRefresh?: boolean }): Promise<AuthCredentials>

  /** Delete the stored token file. Idempotent — missing file is OK. */
  logout(): Promise<void>

  /**
   * Optional one-time import from an external CLI's token store (e.g. the
   * official `codex` CLI's `~/.codex/auth.json`). Returns `true` on
   * success, throws `AuthError` on missing / corrupt / expired source.
   */
  import?(): Promise<true>
}
