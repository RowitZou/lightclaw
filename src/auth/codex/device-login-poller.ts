// Single-flight Codex device-login poller (V1, in-process, not persisted).
//
// Lifecycle (per overview §C):
//   idle ──start──▶ requesting ──usercode 200──▶ polling (init card pushed)
//   polling ──token 200──▶ exchanging ──persist──▶ persisted (success card)
//   polling ──15min──▶ expired (card)
//   polling ──new start, same user──▶ abort old, start new
//   polling ──daemon shutdown / abort──▶ aborted (silent)
//   any step throws ──▶ failed (card)
//
// Per-canonical-user single-flight: a new start aborts the prior in-flight
// login for that user. Nothing is persisted — the window is only ~15 min, so a
// daemon restart simply drops in-flight pollers and the user re-runs the login.
//
// This module is channel-agnostic: card rendering / DM delivery / endpoint-config
// persistence are all injected callbacks, so the auth layer never depends on the
// Feishu layer. Production HTTP is undici + a proxy dispatcher built from the
// codex endpoint's `proxy`; it never reads ambient `http_proxy` / `HTTPS_PROXY`.

import { request, type Dispatcher } from 'undici'

import { buildProxyDispatcher } from '../../provider/proxy.js'
import {
  DeviceLoginError,
  deviceVerifyUrl,
  exchangeAuthCode,
  pollForToken,
  requestUserCode,
  type ExchangedTokens,
} from './device-login.js'
import type { HttpFn } from './provider.js'

/** Lifecycle callbacks. Each is best-effort: a throw is logged and swallowed so
 *  a card-delivery failure never crashes the detached poll loop. */
export type DeviceLoginHandlers = {
  /** Usercode obtained — render the init card (link + code) to the user's DM. */
  onStarted: (info: { userCode: string; verifyUrl: string; expiresAtMs: number }) => Promise<void> | void
  /** Tokens exchanged + persisted — render the success card. */
  onSuccess: (info: { accountId: string }) => Promise<void> | void
  /** 15-min window elapsed without completion — render the expired card. */
  onExpired: () => Promise<void> | void
  /** Any non-abort failure — render the failed card with the reason. */
  onFailed: (detail: string) => Promise<void> | void
}

export type StartDeviceLoginArgs = {
  canonicalUser: string
  /** Issuer override (private mirror); falls back to the public issuer. */
  issuer?: string
  /** Outbound proxy for all 3 HTTP calls (codex endpoint's `proxy`). */
  proxy?: string
  /** Persist the exchanged tokens (per-user store or admin-global store) and
   *  return the derived account id. Runs before `onSuccess`. */
  persist: (tokens: ExchangedTokens) => { accountId: string } | Promise<{ accountId: string }>
  handlers: DeviceLoginHandlers
  // ── test seams ─────────────────────────────────────────────────────────────
  http?: HttpFn
  now?: () => number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  maxWaitMs?: number
}

type InFlight = { controller: AbortController }

const inFlightByUser = new Map<string, InFlight>()

/** Per-request cap for the three login HTTP calls. Without it, undici's
 *  default headersTimeout (300s) is the only bound — and the slash handler
 *  awaits step 1 inline, so a proxy blackhole held the user's `/config
 *  endpoint add --login` reply hostage for up to 5 minutes. */
const LOGIN_HTTP_TIMEOUT_MS = 30_000

function buildHttp(proxy: string | undefined): HttpFn {
  const dispatcher = buildProxyDispatcher(proxy)
  return async ({ url, body, headers, signal }) => {
    const res = await request(url, {
      method: 'POST',
      body,
      headers,
      headersTimeout: LOGIN_HTTP_TIMEOUT_MS,
      bodyTimeout: LOGIN_HTTP_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
      ...(dispatcher ? { dispatcher: dispatcher as Dispatcher } : {}),
    })
    const bodyText = await res.body.text()
    return { statusCode: res.statusCode, bodyText }
  }
}

async function runHandler(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
  } catch (error) {
    process.stderr.write(
      `[codex-device-login] ${label} handler failed: ${error instanceof Error ? error.message : String(error)}\n`,
    )
  }
}

/**
 * Begin a device login for one canonical user. Claims the single-flight slot
 * synchronously (aborting any prior in-flight login), then awaits step 1
 * (usercode) so the caller can report an inline error if the usercode request
 * itself fails — the slot is released on that path; otherwise pushes the init
 * card via `onStarted`, spawns the detached poll/exchange/persist loop, and
 * resolves `ok`. The background loop fires exactly one terminal handler
 * (success / expired / failed), or none on abort.
 */
export async function startDeviceLogin(
  args: StartDeviceLoginArgs,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const http = args.http ?? buildHttp(args.proxy)

  // Single-flight: abort any prior in-flight login for this user, then claim
  // the slot SYNCHRONOUSLY — before the first await. Registering after step 1
  // (the old shape) let two near-simultaneous starts both read the same
  // `prior`: neither aborted the other, the later `set` overwrote the earlier
  // entry, and the overwritten controller became unreachable — two detached
  // poll loops then ran to completion (double persist / a stray "expired"
  // card 15 minutes later).
  const prior = inFlightByUser.get(args.canonicalUser)
  if (prior) prior.controller.abort()
  const controller = new AbortController()
  const entry: InFlight = { controller }
  inFlightByUser.set(args.canonicalUser, entry)

  const releaseSlot = () => {
    if (inFlightByUser.get(args.canonicalUser) === entry) {
      inFlightByUser.delete(args.canonicalUser)
    }
  }

  let userCode
  try {
    userCode = await requestUserCode(http, { issuer: args.issuer, signal: controller.signal })
  } catch (error) {
    releaseSlot()
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    }
  }
  // A newer login (or shutdown) aborted us while step 1 was in flight — bow
  // out before pushing an init card the superseding login makes meaningless.
  if (controller.signal.aborted) {
    releaseSlot()
    return { ok: false, detail: 'Codex device login superseded by a newer attempt.' }
  }

  await runHandler('onStarted', () =>
    args.handlers.onStarted({
      userCode: userCode.userCode,
      verifyUrl: deviceVerifyUrl(args.issuer),
      expiresAtMs: userCode.expiresAtMs,
    }),
  )

  // Detached loop — never awaited by the caller (a login runs up to 15 min).
  void (async () => {
    try {
      const poll = await pollForToken(http, {
        deviceAuthId: userCode.deviceAuthId,
        userCode: userCode.userCode,
        interval: userCode.interval,
        issuer: args.issuer,
        signal: controller.signal,
        ...(args.now ? { now: args.now } : {}),
        ...(args.sleep ? { sleep: args.sleep } : {}),
        ...(args.maxWaitMs !== undefined ? { maxWaitMs: args.maxWaitMs } : {}),
      })
      const exchanged = await exchangeAuthCode(http, {
        code: poll.authorizationCode,
        codeVerifier: poll.codeVerifier,
        issuer: args.issuer,
        signal: controller.signal,
      })
      if (controller.signal.aborted) {
        // Abort landed during the exchange round-trip — never persist a
        // superseded login's tokens over the newer login's credential (or
        // race a file write against daemon shutdown).
        return
      }
      const persisted = await args.persist(exchanged)
      await runHandler('onSuccess', () => args.handlers.onSuccess({ accountId: persisted.accountId }))
    } catch (error) {
      if (controller.signal.aborted || (error instanceof DeviceLoginError && error.reason === 'aborted')) {
        // Superseded by a newer login or daemon shutdown — stay silent. The
        // signal check also swallows transport-level abort rejections from an
        // http implementation that honors `signal` (undici in production).
        return
      }
      if (error instanceof DeviceLoginError && error.reason === 'timeout') {
        await runHandler('onExpired', () => args.handlers.onExpired())
        return
      }
      await runHandler('onFailed', () =>
        args.handlers.onFailed(error instanceof Error ? error.message : String(error)),
      )
    } finally {
      // Only clear the slot if it is still ours (a newer login may have replaced it).
      if (inFlightByUser.get(args.canonicalUser) === entry) {
        inFlightByUser.delete(args.canonicalUser)
      }
    }
  })()

  return { ok: true }
}

/** Abort every in-flight device login (daemon shutdown). Returns the count
 *  aborted. The detached loops observe the abort and exit silently. */
export function abortAllDeviceLogins(): number {
  const n = inFlightByUser.size
  for (const { controller } of inFlightByUser.values()) controller.abort()
  inFlightByUser.clear()
  return n
}

/** Test/diagnostic accessor: number of in-flight device logins. */
export function inFlightDeviceLoginCount(): number {
  return inFlightByUser.size
}
