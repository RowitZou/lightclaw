// OpenAI Codex device-authorization flow (a.k.a. `codex login --device-auth`).
//
// Three pure steps against `auth.openai.com`, mirroring the upstream CLI
// (`codex-rs/login/src/device_code_auth.rs` + `server.rs`):
//   1. requestUserCode  — POST {issuer}/api/accounts/deviceauth/usercode
//   2. pollForToken      — POST {issuer}/api/accounts/deviceauth/token  (loop)
//   3. exchangeAuthCode  — POST {issuer}/oauth/token  (grant=authorization_code)
//
// The whole flow runs server-side: the user only opens a link on any device
// and enters the short user code. No localhost callback server is needed — the
// `redirect_uri` at step 3 is only checked for equality, never visited.
//
// HTTP is injected via the same `HttpFn` shape the refresh path uses
// (`provider.ts`), so tests stub it and production passes an undici-backed fn
// built with `buildProxyDispatcher` from the codex endpoint's `proxy`. This
// module never reads ambient `http_proxy` / `HTTPS_PROXY`.

import {
  CODEX_DEVICE_MAX_WAIT_MS,
  CODEX_DEVICE_REDIRECT_PATH,
  CODEX_DEVICE_TOKEN_PATH,
  CODEX_DEVICE_USERCODE_PATH,
  CODEX_OAUTH_CLIENT_ID,
  CODEX_OAUTH_ISSUER,
} from './constants.js'
import type { HttpFn } from './provider.js'

/** Why a device-login step failed. The poller (PR3) branches on this to pick
 *  the user-facing card: `aborted` is silent (superseded / shutdown), `timeout`
 *  pushes the expired card, everything else pushes the failed card. */
export type DeviceLoginErrorReason = 'aborted' | 'timeout' | 'http' | 'malformed'

export class DeviceLoginError extends Error {
  readonly reason: DeviceLoginErrorReason
  /** HTTP status when `reason === 'http'`; 0 otherwise. */
  readonly status: number

  constructor(opts: { reason: DeviceLoginErrorReason; message: string; status?: number }) {
    super(opts.message)
    this.name = 'DeviceLoginError'
    this.reason = opts.reason
    this.status = opts.status ?? 0
  }
}

/** Result of step 1. `interval` is seconds (the wire value is a string, parsed
 *  here); `expiresAtMs` is the server-stamped absolute expiry in epoch ms. */
export type UserCodeResult = {
  deviceAuthId: string
  userCode: string
  interval: number
  expiresAtMs: number
}

/** Result of step 3 — the exchanged token triple. Expiry / account_id are NOT
 *  returned here (the endpoint does not send them); the caller derives them
 *  from the access_token JWT, exactly like the CLI-import path. */
export type ExchangedTokens = {
  idToken?: string
  accessToken: string
  refreshToken: string
}

/** Resolve the issuer base for one device-login attempt. An endpoint may
 *  override it (private Codex mirror); empty / whitespace falls back to the
 *  public issuer. Trailing slashes are trimmed so path concatenation is clean. */
export function resolveDeviceIssuer(override?: string | null): string {
  const trimmed = override?.trim()
  return (trimmed && trimmed.length > 0 ? trimmed : CODEX_OAUTH_ISSUER).replace(/\/+$/, '')
}

function apiBase(issuer: string): string {
  return `${issuer}/api/accounts`
}

function parseJson(bodyText: string): unknown {
  try {
    return JSON.parse(bodyText)
  } catch {
    return null
  }
}

/** Step 1 — request a device user code. Throws `DeviceLoginError` on non-200
 *  (404 = device login not enabled on this server) or a malformed body. */
export async function requestUserCode(
  http: HttpFn,
  opts: { clientId?: string; issuer?: string } = {},
): Promise<UserCodeResult> {
  const issuer = resolveDeviceIssuer(opts.issuer)
  const clientId = opts.clientId ?? CODEX_OAUTH_CLIENT_ID
  const { statusCode, bodyText } = await http({
    url: `${apiBase(issuer)}${CODEX_DEVICE_USERCODE_PATH}`,
    body: JSON.stringify({ client_id: clientId }),
    headers: { 'content-type': 'application/json', accept: 'application/json' },
  })
  if (statusCode !== 200) {
    const hint =
      statusCode === 404
        ? ' — device login is not enabled for this Codex server'
        : ''
    throw new DeviceLoginError({
      reason: 'http',
      status: statusCode,
      message: `Codex device usercode request failed with status ${statusCode}${hint}.`,
    })
  }
  const parsed = parseJson(bodyText) as
    | { device_auth_id?: unknown; user_code?: unknown; interval?: unknown; expires_at?: unknown }
    | null
  const deviceAuthId = parsed?.device_auth_id
  const userCode = parsed?.user_code
  if (typeof deviceAuthId !== 'string' || !deviceAuthId || typeof userCode !== 'string' || !userCode) {
    throw new DeviceLoginError({
      reason: 'malformed',
      message: 'Codex device usercode response missing device_auth_id / user_code.',
    })
  }
  // `interval` arrives as a string ("5"); the CLI parses it the same way.
  // Fall back to 5s on a missing / unparseable value.
  const intervalRaw = parsed?.interval
  const intervalParsed =
    typeof intervalRaw === 'string'
      ? Number.parseInt(intervalRaw.trim(), 10)
      : typeof intervalRaw === 'number'
        ? intervalRaw
        : NaN
  const interval = Number.isFinite(intervalParsed) && intervalParsed > 0 ? intervalParsed : 5
  // `expires_at` is an ISO timestamp; fall back to now + max-wait when absent.
  const expiresAtRaw = parsed?.expires_at
  const expiresParsed = typeof expiresAtRaw === 'string' ? Date.parse(expiresAtRaw) : NaN
  const expiresAtMs = Number.isFinite(expiresParsed) ? expiresParsed : Date.now() + CODEX_DEVICE_MAX_WAIT_MS
  return { deviceAuthId, userCode, interval, expiresAtMs }
}

/** Result of step 3 polling success — the authorization code + server-generated
 *  PKCE verifier (no local PKCE math needed). */
export type PollResult = {
  authorizationCode: string
  codeVerifier: string
  codeChallenge?: string
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DeviceLoginError({ reason: 'aborted', message: 'Codex device login aborted.' }))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DeviceLoginError({ reason: 'aborted', message: 'Codex device login aborted.' }))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Step 3 — poll the token endpoint until the user approves on their device.
 *  `403` / `404` mean "not yet, keep waiting" → sleep(interval) and retry.
 *  Any other non-200 terminates with a `DeviceLoginError`. The loop is bounded
 *  by `CODEX_DEVICE_MAX_WAIT_MS` (throws `reason:'timeout'`) and by `signal`
 *  (throws `reason:'aborted'`). `now` / `sleep` are injectable for tests. */
export async function pollForToken(
  http: HttpFn,
  opts: {
    deviceAuthId: string
    userCode: string
    interval: number
    issuer?: string
    signal?: AbortSignal
    now?: () => number
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
    maxWaitMs?: number
  },
): Promise<PollResult> {
  const issuer = resolveDeviceIssuer(opts.issuer)
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? defaultSleep
  const maxWaitMs = opts.maxWaitMs ?? CODEX_DEVICE_MAX_WAIT_MS
  const intervalMs = Math.max(1, opts.interval) * 1000
  const start = now()
  const url = `${apiBase(issuer)}${CODEX_DEVICE_TOKEN_PATH}`

  for (;;) {
    if (opts.signal?.aborted) {
      throw new DeviceLoginError({ reason: 'aborted', message: 'Codex device login aborted.' })
    }
    const { statusCode, bodyText } = await http({
      url,
      body: JSON.stringify({ device_auth_id: opts.deviceAuthId, user_code: opts.userCode }),
      headers: { 'content-type': 'application/json', accept: 'application/json' },
    })
    if (statusCode === 200) {
      const parsed = parseJson(bodyText) as
        | { authorization_code?: unknown; code_verifier?: unknown; code_challenge?: unknown }
        | null
      const authorizationCode = parsed?.authorization_code
      const codeVerifier = parsed?.code_verifier
      if (
        typeof authorizationCode !== 'string' ||
        !authorizationCode ||
        typeof codeVerifier !== 'string' ||
        !codeVerifier
      ) {
        throw new DeviceLoginError({
          reason: 'malformed',
          message: 'Codex device token response missing authorization_code / code_verifier.',
        })
      }
      return {
        authorizationCode,
        codeVerifier,
        ...(typeof parsed?.code_challenge === 'string' ? { codeChallenge: parsed.code_challenge } : {}),
      }
    }
    if (statusCode === 403 || statusCode === 404) {
      if (now() - start >= maxWaitMs) {
        throw new DeviceLoginError({
          reason: 'timeout',
          message: 'Codex device login was not completed within the allowed window.',
        })
      }
      // Clamp the final sleep so we never overshoot the hard deadline.
      const remaining = maxWaitMs - (now() - start)
      await sleep(Math.min(intervalMs, Math.max(1, remaining)), opts.signal)
      continue
    }
    throw new DeviceLoginError({
      reason: 'http',
      status: statusCode,
      message: `Codex device token poll failed with status ${statusCode}.`,
    })
  }
}

/** Step 4 — exchange the authorization code for the final token triple. Same
 *  `{issuer}/oauth/token` endpoint as the refresh grant, form-urlencoded. */
export async function exchangeAuthCode(
  http: HttpFn,
  opts: {
    code: string
    codeVerifier: string
    clientId?: string
    issuer?: string
    redirectUri?: string
  },
): Promise<ExchangedTokens> {
  const issuer = resolveDeviceIssuer(opts.issuer)
  const clientId = opts.clientId ?? CODEX_OAUTH_CLIENT_ID
  const redirectUri = opts.redirectUri ?? `${issuer}${CODEX_DEVICE_REDIRECT_PATH}`
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: opts.code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: opts.codeVerifier,
  }).toString()
  const { statusCode, bodyText } = await http({
    url: `${issuer}/oauth/token`,
    body,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
  })
  if (statusCode !== 200) {
    const parsed = parseJson(bodyText) as { error?: unknown; error_description?: unknown } | null
    const errCode = typeof parsed?.error === 'string' ? parsed.error : ''
    const errDesc = typeof parsed?.error_description === 'string' ? parsed.error_description : ''
    throw new DeviceLoginError({
      reason: 'http',
      status: statusCode,
      message:
        `Codex device token exchange failed with status ${statusCode}` +
        (errCode ? ` (${errCode})` : '') +
        (errDesc ? `: ${errDesc}` : '') +
        '.',
    })
  }
  const parsed = parseJson(bodyText) as
    | { id_token?: unknown; access_token?: unknown; refresh_token?: unknown }
    | null
  const accessToken = parsed?.access_token
  const refreshToken = parsed?.refresh_token
  if (typeof accessToken !== 'string' || !accessToken || typeof refreshToken !== 'string' || !refreshToken) {
    throw new DeviceLoginError({
      reason: 'malformed',
      message: 'Codex device token exchange response missing access_token / refresh_token.',
    })
  }
  return {
    accessToken,
    refreshToken,
    ...(typeof parsed?.id_token === 'string' ? { idToken: parsed.id_token } : {}),
  }
}
