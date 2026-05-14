/**
 * Transient-network retry for daemon-side WebSearch / WebFetch HTTP egress.
 *
 * 2026-05-14 dogfood: WebSearch + WebFetch both failed inside two tight
 * (~30 s) windows with `Client network socket disconnected before secure
 * TLS connection was established` — the egress proxy (`runtime.network.proxy`)
 * blipped, and because neither tool retried, a sub-second socket reset became
 * a hard, user-visible `... failed (exit 1)`. The tell that it was transient,
 * not a tool bug: within a single parallel batch some calls succeeded and
 * some failed at the same millisecond, and the same tool worked fine minutes
 * before and after. This helper absorbs that error class with bounded
 * exponential backoff + jitter (jitter matters here — the failures arrived
 * as parallel bursts, so un-jittered retries would re-collide on the proxy).
 *
 * Scope is deliberately narrow — retry ONLY errors a blind re-send can
 * plausibly fix:
 *  - socket-level resets / hang-ups / TLS-handshake aborts (ECONNRESET,
 *    EPIPE, "socket disconnected", "socket hang up")
 *  - connection refused / network unreachable (ECONNREFUSED, ENETUNREACH,
 *    EHOSTUNREACH, libuv ETIMEDOUT)
 *  - transient DNS (EAI_AGAIN — but NOT ENOTFOUND, a real config error)
 *  - HTTP 502 / 503 / 504 from the upstream (transient infra, unambiguous)
 *
 * Explicitly NOT retried:
 *  - abort / cancellation — the caller asked to stop; re-sending defies intent
 *  - axios timeout (ECONNABORTED) — the request already burned its full time
 *    budget; retrying just triples the wait for no new information
 *  - 4xx incl. 401 / 403 / 404 / 429 — bad key, blocked, gone, quota: a
 *    re-send returns the same answer
 *  - HTTP 500 — ambiguous, usually a real upstream bug rather than a blip
 *
 * Mirrors the shape of `channels/feishu/resources/retry.ts::withFeishuRetry`
 * (same backoff math, same `onRetry` hook). Kept as a separate tool-layer
 * helper rather than generalized: the retryability predicate is domain-
 * specific, and merging would couple the Feishu error taxonomy to the web
 * tools for no real gain.
 */

const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_BASE_DELAY_MS = 300
const DEFAULT_MAX_DELAY_MS = 4000

/** HTTP statuses a blind re-send can plausibly fix. 502/503/504 are
 *  unambiguous transient-infra signals; 500 and 429 are deliberately
 *  excluded (see file header). */
const RETRYABLE_HTTP_STATUSES = new Set([502, 503, 504])

/** Node / libuv error codes for socket-level failures a re-send can
 *  recover. ECONNABORTED (axios timeout) and ENOTFOUND (DNS miss) are
 *  intentionally absent. */
const RETRYABLE_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ETIMEDOUT', // libuv connect timeout — distinct from axios's ECONNABORTED
  'EAI_AGAIN', // transient DNS failure (NOT ENOTFOUND)
  'ERR_SOCKET_CONNECTION_TIMEOUT',
])

/** Lowercased message-substring fallback for socket errors Node throws
 *  without a stable `.code`, or where axios / https-proxy-agent rewrites
 *  it. The first entry is the exact 2026-05-14 dogfood error. */
const RETRYABLE_MESSAGE_FRAGMENTS = [
  'socket disconnected before secure tls',
  'client network socket disconnected',
  'network socket disconnected',
  'socket hang up',
]

/**
 * Thrown by callers that run their own `validateStatus` (Brave) when the
 * upstream status is in {@link RETRYABLE_HTTP_STATUSES}. `withWebRetry`'s
 * predicate recognizes it; the caller keeps full control of the
 * non-retryable-status branch (BAD_KEY / QUOTA_EXCEEDED still throw their
 * own body-carrying Error so admin grep is unaffected).
 */
export class WebRetryableHttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'WebRetryableHttpError'
    this.status = status
  }
}

/** True if `status` is one a blind re-send can plausibly fix. Callers that
 *  run their own `validateStatus` use this to decide between
 *  `WebRetryableHttpError` and a plain fatal throw. */
export function isRetryableHttpStatus(status: number): boolean {
  return RETRYABLE_HTTP_STATUSES.has(status)
}

/** Abort / cancellation surfaces under several names across axios and Node;
 *  none of them should ever be retried — the caller asked to stop. */
function isAbortError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const e = err as { name?: unknown; code?: unknown }
  return (
    e.name === 'CanceledError' || // axios abort
    e.name === 'AbortError' || // Node / fetch abort
    e.code === 'ERR_CANCELED' ||
    e.code === 'ABORT_ERR'
  )
}

/**
 * Classify a thrown error as transient (worth a re-send) or fatal. See the
 * file header for the full include / exclude rationale.
 */
export function isTransientNetworkError(err: unknown): boolean {
  if (isAbortError(err)) return false
  if (err instanceof WebRetryableHttpError) return true
  if (typeof err !== 'object' || err === null) return false
  const e = err as {
    code?: unknown
    message?: unknown
    response?: { status?: unknown }
  }
  // axios timeout: the request already waited its full budget — do not retry.
  if (e.code === 'ECONNABORTED') return false
  if (typeof e.code === 'string' && RETRYABLE_ERROR_CODES.has(e.code)) {
    return true
  }
  const status = e.response?.status
  if (typeof status === 'number' && RETRYABLE_HTTP_STATUSES.has(status)) {
    return true
  }
  if (typeof e.message === 'string') {
    const lower = e.message.toLowerCase()
    if (RETRYABLE_MESSAGE_FRAGMENTS.some((frag) => lower.includes(frag))) {
      return true
    }
  }
  return false
}

export interface WebRetryOptions {
  /** Short tag for the stderr diagnostic line, e.g. 'WebSearch/brave'. */
  label: string
  /** Abort signal from the tool call context. An already-aborted signal
   *  short-circuits before the first attempt; a backoff sleep wakes early
   *  on abort so `/stop` is responsive mid-retry. */
  signal?: AbortSignal
  maxAttempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  /** Override the retryability predicate (default: isTransientNetworkError). */
  isRetryable?: (err: unknown) => boolean
  /** Called once per backoff sleep, before the wait. Defaults to a one-line
   *  stderr diagnostic so admins can grep transient-vs-fatal rates. */
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void
}

/** Test-only delay override. When set, withWebRetry uses these instead of
 *  the production constants — keeps brave / ddg / web-fetch-http retry-path
 *  tests from sleeping real backoff. Tests reset to null in afterEach. */
let testDelayOverride: { baseDelayMs: number; maxDelayMs: number } | null = null
export function _setWebRetryDelaysForTests(
  v: { baseDelayMs: number; maxDelayMs: number } | null,
): void {
  testDelayOverride = v
}

/**
 * Run `fn`, retrying transient network failures with bounded exponential
 * backoff. Resolves with `fn`'s result on the first success; throws the
 * last error once the attempt budget is spent or the error is fatal.
 *
 * The retryable unit is whatever `fn` does — callers wrap just the HTTP
 * round-trip, not response parsing, so a retry never re-runs deterministic
 * post-processing.
 */
export async function withWebRetry<T>(
  fn: () => Promise<T>,
  opts: WebRetryOptions,
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const baseDelayMs =
    opts.baseDelayMs ?? testDelayOverride?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS
  const maxDelayMs =
    opts.maxDelayMs ?? testDelayOverride?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS
  const isRetryable = opts.isRetryable ?? isTransientNetworkError
  const onRetry = opts.onRetry ?? defaultOnRetry(opts.label)

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (opts.signal?.aborted) {
      // Aborted between attempts — surface as a throw, never a silent retry.
      throw new Error(`${opts.label} aborted`)
    }
    try {
      const result = await fn()
      if (attempt > 1) {
        process.stderr.write(
          `[web-retry] ${opts.label}: recovered after ${attempt - 1} ` +
            `retr${attempt - 1 === 1 ? 'y' : 'ies'} (transient)\n`,
        )
      }
      return result
    } catch (err) {
      if (attempt >= maxAttempts || !isRetryable(err)) throw err
      const delayMs = jitter(
        Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs),
      )
      onRetry(err, attempt, delayMs)
      await sleep(delayMs, opts.signal)
    }
  }
  // Unreachable: the loop body either returns or throws on the final attempt.
  throw new Error(`${opts.label}: retry loop exited without result`)
}

/** Decorrelated half-jitter: random in [delay/2, delay]. The 2026-05-14
 *  failures arrived as parallel bursts (3 WebSearch calls failing at the
 *  same millisecond) — without jitter all three would retry in lockstep
 *  and re-collide on the same proxy. */
function jitter(delayMs: number): number {
  return Math.round(delayMs / 2 + Math.random() * (delayMs / 2))
}

/** Backoff sleep that wakes early on abort. The early wake doesn't itself
 *  throw — the next loop iteration sees `signal.aborted` and throws — which
 *  keeps the abort path single-sourced. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function defaultOnRetry(
  label: string,
): (err: unknown, attempt: number, delayMs: number) => void {
  return (err, attempt, delayMs) => {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(
      `[web-retry] ${label}: transient error on attempt ${attempt}, ` +
        `retrying in ${delayMs}ms — ${msg}\n`,
    )
  }
}
