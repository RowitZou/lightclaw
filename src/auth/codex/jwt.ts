// Minimal JWT payload extractor for Codex tokens.
// Codex's access_token and id_token are JWTs whose payload contains the
// `https://api.openai.com/auth.account_id` claim. The Codex backend
// rejects requests without this account id in the `chatgpt-account-id`
// header, so we always extract it at import time and cache it alongside
// the tokens.
//
// We do NOT verify the signature — these tokens were issued by OpenAI
// to begin with, and even if a malicious actor could substitute a JWT,
// they could only mint a token that fails at the API level. This module
// is a pure payload decoder, not an authentication primitive.

const ACCOUNT_ID_CLAIM = 'https://api.openai.com/auth'

/** Decode a JWT payload and return the OpenAI auth.account_id claim,
 *  or `null` if the token isn't a valid JWT or has no claim. */
export function decodeAccountId(jwt: string): string | null {
  const parts = jwt.split('.')
  if (parts.length !== 3) {
    return null
  }
  let payload: unknown
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
    const raw = Buffer.from(padded, 'base64').toString('utf8')
    payload = JSON.parse(raw)
  } catch {
    return null
  }
  if (!payload || typeof payload !== 'object') {
    return null
  }
  const auth = (payload as Record<string, unknown>)[ACCOUNT_ID_CLAIM]
  if (!auth || typeof auth !== 'object') {
    return null
  }
  // The live claim field is `chatgpt_account_id` (the org/workspace id the codex
  // backend wants in the `chatgpt-account-id` header) — see the upstream CLI's
  // `AuthClaims` (`codex-rs/login/src/token_data.rs`). The CLI-import path rarely
  // exercises this decode because `auth.json` carries a pre-extracted
  // `tokens.account_id` file field, but device-login has no file and decodes the
  // JWT itself — reading only `account_id`/`accountId` silently returned empty
  // and dropped the header (2026-06-30 dogfood: success card showed `account=—`).
  // Keep `account_id`/`accountId` as fallbacks for any legacy token shape.
  const a = auth as Record<string, unknown>
  const accountId = a.chatgpt_account_id ?? a.account_id ?? a.accountId
  return typeof accountId === 'string' && accountId.length > 0
    ? accountId
    : null
}

/** Try `id_token` first, then `access_token`. Returns the first claim
 *  found, or empty string if neither has it. */
export function extractAccountIdFromTokens(tokens: {
  id_token?: string
  access_token?: string
}): string {
  const id = tokens.id_token && decodeAccountId(tokens.id_token)
  if (id) return id
  const access = tokens.access_token && decodeAccountId(tokens.access_token)
  if (access) return access
  return ''
}

/** Decode the JWT `exp` claim and return it as Unix epoch ms.
 *  Returns null when the token isn't a valid JWT or has no numeric exp. */
export function decodeExpiresAtMs(jwt: string): number | null {
  const parts = jwt.split('.')
  if (parts.length !== 3) {
    return null
  }
  let payload: unknown
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
    const raw = Buffer.from(padded, 'base64').toString('utf8')
    payload = JSON.parse(raw)
  } catch {
    return null
  }
  if (!payload || typeof payload !== 'object') {
    return null
  }
  const exp = (payload as Record<string, unknown>).exp
  if (typeof exp !== 'number' || !Number.isFinite(exp)) {
    return null
  }
  // JWT exp is unix seconds; LightClaw stores ms.
  return Math.floor(exp * 1000)
}
