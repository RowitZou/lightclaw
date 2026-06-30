import { existsSync, readFileSync } from 'node:fs'
import { request, type Dispatcher } from 'undici'

import { buildProxyDispatcher } from '../../provider/proxy.js'
import {
  AuthError,
  type AuthCredentials,
  type AuthProvider,
} from '../types.js'
import {
  deleteTokenFile,
  readTokenFile,
  writeTokenFile,
} from '../storage.js'
import {
  CODEX_OAUTH_CLIENT_ID,
  CODEX_OAUTH_TOKEN_URL,
  CODEX_REFRESH_SKEW_SECONDS,
  codexCliAuthFilePath,
} from './constants.js'
import { decodeExpiresAtMs, extractAccountIdFromTokens } from './jwt.js'

const PROVIDER_NAME = 'codex'

/** On-disk shape for `<lightclawHome>/auth/codex.json` AND for each per-user
 *  BYO Codex store at `users/<canonical>/state/auth/codex/<name>.json`
 *  (`src/auth/codex/user-store.ts`). Exported so the per-user store reuses the
 *  exact same shape — the two paths must never drift. */
export type StoredCodexTokens = {
  tokens: {
    access_token: string
    refresh_token: string
    /** Unix epoch ms. Note: OpenAI CLI uses ISO; we normalize to ms. */
    expires_at: number
    id_token?: string
  }
  account_id: string
  imported_at?: string
  last_refresh?: string
  source: 'codex-cli-import' | 'lightclaw-refresh' | 'codex-device-login'
}

/** Shape of the OpenAI Codex CLI's `~/.codex/auth.json` as of mid-2026.
 *  Important: the upstream file does NOT carry an explicit expires_at —
 *  we derive expiry from the access_token JWT's `exp` claim. The
 *  account_id is stored under tokens.account_id (not as a JWT claim,
 *  though the JWT also carries it as fallback). Extra fields ignored. */
type CodexCliAuthFile = {
  auth_mode?: string
  OPENAI_API_KEY?: string | null
  tokens?: {
    id_token?: string
    access_token?: string
    refresh_token?: string
    account_id?: string
  }
  last_refresh?: string
}

/** OAuth token endpoint response (success path). */
type RefreshResponse = {
  access_token: string
  refresh_token: string
  id_token?: string
  expires_in: number
  token_type: string
}

/** OAuth token endpoint response (error path). */
type RefreshErrorResponse = {
  error?: string
  error_description?: string
}

/** Pluggable HTTP for tests. Production uses undici with an optional
 *  ProxyAgent built from the `endpoints.codex.proxy` config value passed
 *  to `createCodexAuthProvider({ proxy })`. */
export type HttpFn = (input: {
  url: string
  body: string
  headers: Record<string, string>
}) => Promise<{ statusCode: number; bodyText: string }>

function buildDefaultHttp(dispatcher: Dispatcher | undefined): HttpFn {
  return async ({ url, body, headers }) => {
    const res = await request(url, {
      method: 'POST',
      body,
      headers,
      ...(dispatcher ? { dispatcher } : {}),
    })
    const bodyText = await res.body.text()
    return { statusCode: res.statusCode, bodyText }
  }
}

function isExpiringSoon(expiresAtMs: number, skewSeconds: number): boolean {
  return Date.now() + skewSeconds * 1000 >= expiresAtMs
}


function readStored(): StoredCodexTokens | null {
  const raw = readTokenFile(PROVIDER_NAME)
  if (raw === null) return null
  if (!raw || typeof raw !== 'object') {
    throw new AuthError({
      code: 'tokens_invalid_shape',
      provider: PROVIDER_NAME,
      message: `Codex auth store has unexpected shape (not an object).`,
    })
  }
  const r = raw as Partial<StoredCodexTokens> & {
    tokens?: Partial<StoredCodexTokens['tokens']>
  }
  const tokens = r.tokens
  const accessToken = tokens?.access_token
  const refreshToken = tokens?.refresh_token
  const expiresAt = tokens?.expires_at
  if (
    !accessToken ||
    !refreshToken ||
    typeof accessToken !== 'string' ||
    typeof refreshToken !== 'string' ||
    typeof expiresAt !== 'number'
  ) {
    throw new AuthError({
      code: 'tokens_invalid_shape',
      provider: PROVIDER_NAME,
      message:
        `Codex auth store is missing required fields ` +
        `(tokens.access_token / tokens.refresh_token / tokens.expires_at).`,
    })
  }
  return {
    tokens: {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: expiresAt,
      ...(tokens?.id_token ? { id_token: tokens.id_token } : {}),
    },
    account_id: typeof r.account_id === 'string' ? r.account_id : '',
    ...(r.imported_at ? { imported_at: r.imported_at } : {}),
    ...(r.last_refresh ? { last_refresh: r.last_refresh } : {}),
    source:
      r.source === 'lightclaw-refresh' || r.source === 'codex-device-login'
        ? r.source
        : 'codex-cli-import',
  }
}

/** Perform the OAuth refresh-token grant against `auth.openai.com`. Exported
 *  so the per-user BYO Codex store reuses the exact same transport / token URL
 *  / client id / error classification as the global path — there is a single
 *  refresh implementation. */
export async function refreshCodexTokens(
  http: HttpFn,
  refreshToken: string,
): Promise<RefreshResponse> {
  return refreshTokens(http, refreshToken)
}

async function refreshTokens(
  http: HttpFn,
  refreshToken: string,
): Promise<RefreshResponse> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CODEX_OAUTH_CLIENT_ID,
  }).toString()
  const { statusCode, bodyText } = await http({
    url: CODEX_OAUTH_TOKEN_URL,
    body,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
  })
  if (statusCode === 200) {
    let parsed: RefreshResponse
    try {
      parsed = JSON.parse(bodyText) as RefreshResponse
    } catch {
      throw new AuthError({
        code: 'refresh_failed',
        provider: PROVIDER_NAME,
        message: `Codex token refresh returned invalid JSON.`,
      })
    }
    if (!parsed.access_token || !parsed.refresh_token) {
      throw new AuthError({
        code: 'refresh_failed',
        provider: PROVIDER_NAME,
        message: `Codex token refresh response was missing access_token or refresh_token.`,
      })
    }
    return parsed
  }
  // Surface the most useful diagnostic we can extract from the error body.
  let errorBody: RefreshErrorResponse = {}
  try {
    errorBody = JSON.parse(bodyText) as RefreshErrorResponse
  } catch {
    // body wasn't JSON
  }
  const errorCode = errorBody.error ?? ''
  if (statusCode === 401 || errorCode === 'invalid_grant') {
    throw new AuthError({
      code: 'refresh_consumed_by_other_client',
      provider: PROVIDER_NAME,
      message:
        `Codex refresh token was rejected (status ${statusCode}, error=${errorCode || 'unknown'}) — ` +
        `another client likely rotated it, or it was revoked. Re-connect this Codex endpoint: ` +
        `\`/admin endpoint add <alias> --type codex --login\` (web login), or re-import a fresh ` +
        `auth.json with \`--auth-path\`.`,
    })
  }
  throw new AuthError({
    code: 'refresh_failed',
    provider: PROVIDER_NAME,
    message:
      `Codex token refresh failed with status ${statusCode}` +
      (errorCode ? ` (${errorCode})` : '') +
      (errorBody.error_description ? `: ${errorBody.error_description}` : '') +
      `.`,
  })
}

/** Parse + validate an OpenAI Codex CLI `auth.json` at an ARBITRARY path and
 *  return the normalized `StoredCodexTokens` WITHOUT writing it anywhere. The
 *  global import wrapper writes the result to `<home>/auth/codex.json`; the
 *  per-user BYO store writes it under the user's own dir. Single source of
 *  truth for the CLI-file shape, the `expires_at`-from-JWT-`exp` derivation
 *  (the CLI file has no explicit `expires_at`), and the already-expired guard. */
export function loadCodexCliTokens(cliPath: string): StoredCodexTokens {
  if (!existsSync(cliPath)) {
    throw new AuthError({
      code: 'auth_missing',
      provider: PROVIDER_NAME,
      message:
        `Could not find Codex CLI auth file at ${cliPath}. ` +
        `Install the official CLI and login first: ` +
        `\`npm i -g @openai/codex && codex login\`.`,
    })
  }
  let parsed: CodexCliAuthFile
  try {
    parsed = JSON.parse(readFileSync(cliPath, 'utf8')) as CodexCliAuthFile
  } catch {
    throw new AuthError({
      code: 'tokens_invalid_shape',
      provider: PROVIDER_NAME,
      message: `Codex CLI auth file at ${cliPath} is not valid JSON.`,
    })
  }
  const tokens = parsed.tokens
  if (
    !tokens?.access_token ||
    !tokens.refresh_token
  ) {
    throw new AuthError({
      code: 'tokens_invalid_shape',
      provider: PROVIDER_NAME,
      message:
        `Codex CLI auth file at ${cliPath} is missing tokens.access_token / tokens.refresh_token. ` +
        `Re-run \`codex login\`.`,
    })
  }
  // The upstream Codex CLI file does NOT carry an explicit expires_at.
  // Derive it from the access_token JWT's `exp` claim — that's where
  // OpenAI auth.openai.com stamps the expiry, and what hermes /
  // openclaw both decode at import time.
  const expiresAtMs = decodeExpiresAtMs(tokens.access_token)
  if (expiresAtMs === null) {
    throw new AuthError({
      code: 'tokens_invalid_shape',
      provider: PROVIDER_NAME,
      message:
        `Codex CLI auth file at ${cliPath}: could not decode expiry from access_token JWT. ` +
        `Re-run \`codex login\` to mint fresh tokens.`,
    })
  }
  if (expiresAtMs <= Date.now()) {
    throw new AuthError({
      code: 'tokens_expired',
      provider: PROVIDER_NAME,
      message:
        `Codex CLI tokens at ${cliPath} are already expired. ` +
        `Re-run \`codex login\` to mint fresh tokens.`,
    })
  }
  // account_id is stored at tokens.account_id directly in the upstream
  // CLI file. Fall back to JWT decode for older variants.
  const accountId =
    (typeof tokens.account_id === 'string' && tokens.account_id) ||
    extractAccountIdFromTokens({
      id_token: tokens.id_token,
      access_token: tokens.access_token,
    })
  const stored: StoredCodexTokens = {
    tokens: {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: expiresAtMs,
      ...(tokens.id_token ? { id_token: tokens.id_token } : {}),
    },
    account_id: accountId,
    imported_at: new Date().toISOString(),
    ...(parsed.last_refresh ? { last_refresh: parsed.last_refresh } : {}),
    source: 'codex-cli-import',
  }
  return stored
}

/** Global import: read the default Codex CLI file and persist it to
 *  `<home>/auth/codex.json`. */
function importFromCodexCli(): StoredCodexTokens {
  const stored = loadCodexCliTokens(codexCliAuthFilePath())
  writeTokenFile(PROVIDER_NAME, stored)
  return stored
}

export type CodexAuthProviderOptions = {
  /** Override the HTTP function for tests. Production omits this. */
  http?: HttpFn
  /** Override the refresh skew (seconds). Production uses the constant. */
  refreshSkewSeconds?: number
  /** Explicit proxy URL for the OAuth token refresh path. Sourced from
   *  `endpoints.codex.proxy` at registration time. Empty / undefined =
   *  direct connect. */
  proxy?: string
}

export function createCodexAuthProvider(
  opts: CodexAuthProviderOptions = {},
): AuthProvider {
  const http = opts.http ?? buildDefaultHttp(buildProxyDispatcher(opts.proxy))
  const skew = opts.refreshSkewSeconds ?? CODEX_REFRESH_SKEW_SECONDS

  async function getCredentials(): Promise<AuthCredentials> {
    const stored = readStored()
    if (!stored) {
      throw new AuthError({
        code: 'auth_missing',
        provider: PROVIDER_NAME,
        message:
          `No Codex credentials stored. Connect via web login: ` +
          `\`/admin endpoint add <alias> --type codex --login\` — or import an auth.json with \`--auth-path <file>\`.`,
      })
    }
    if (!isExpiringSoon(stored.tokens.expires_at, skew)) {
      return {
        accessToken: stored.tokens.access_token,
        expiresAt: stored.tokens.expires_at,
        accountId: stored.account_id,
      }
    }
    const refreshed = await refreshTokens(http, stored.tokens.refresh_token)
    const newAccountId = extractAccountIdFromTokens({
      id_token: refreshed.id_token,
      access_token: refreshed.access_token,
    }) || stored.account_id
    const newStored: StoredCodexTokens = {
      tokens: {
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token,
        expires_at: Date.now() + refreshed.expires_in * 1000,
        ...(refreshed.id_token ? { id_token: refreshed.id_token } : {}),
      },
      account_id: newAccountId,
      ...(stored.imported_at ? { imported_at: stored.imported_at } : {}),
      last_refresh: new Date().toISOString(),
      source: 'lightclaw-refresh',
    }
    writeTokenFile(PROVIDER_NAME, newStored)
    return {
      accessToken: newStored.tokens.access_token,
      expiresAt: newStored.tokens.expires_at,
      accountId: newStored.account_id,
    }
  }

  async function logout(): Promise<void> {
    deleteTokenFile(PROVIDER_NAME)
  }

  async function importFn(): Promise<true> {
    importFromCodexCli()
    return true
  }

  return {
    name: PROVIDER_NAME,
    getCredentials,
    logout,
    import: importFn,
  }
}
