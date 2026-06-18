/**
 * Transient-vs-fatal classification for a query() / streamChat throw, shared
 * by the per-turn retry inside query.ts and the whole-query retry in the
 * channel runner. A standalone module so both can import it without a
 * query.ts <-> channels/runner.ts import cycle.
 */

// Network-error message fragments that are expected to be transient. This is
// the LAST-resort fallback for errors that carry no structured signal (no
// HTTP status, no Node/undici error `code`); structured classification in
// isTransientError() is the primary path.
const TRANSIENT_FAILURE_PATTERN =
  /Connection error|ECONNRESET|ECONNABORTED|ETIMEDOUT|EAI_AGAIN|EPIPE|socket hang up|network|TLS|secure|stream returned no events|terminated|fetch failed|other side closed|UND_ERR/i

const BILLING_FAILURE_PATTERN =
  /insufficient[_\s-]?quota|insufficient credits?|insufficient balance|\binsufficient \w+ balance\b|credit balance|credits? (?:have been )?exhausted|no usable credits?|exceeded your current quota|payment required|402 payment|billing hard limit|hard limit reached|(?:monthly )?spend(?:ing)? limit|out of funds|run out of funds|balance[_\s-]?depleted|top up your credits?|requires? more credits?|add more credits?|plan does not include|does not have a valid coding plan subscription|account is deactivated|used all available credits?|out of extra usage|extra usage is required|InvalidSubscription|余额不足|账户余额不足|欠费|账户已欠费|配额不足|配额已用尽|额度不足|额度已用尽/i

const BILLING_ERROR_TYPE = new Set([
  'insufficient_quota',
  'payment_required',
  'billing_not_active',
  'insufficient_credits',
  'no_usable_credits',
  'balance_depleted',
  'model_not_supported_on_free_tier',
  'invalidsubscription',
  '1311',
])

const QUOTA_SELF_HEAL_SIGNAL =
  /try again|retry|resets at|reset in|wait|\bwindow\b|periodic|requests remaining|(?:daily|weekly|monthly)[^.]*reset|automatic quota refresh|rolling time window|subscription quota limit[^.]*refresh/i

const OVERLOADED_PATTERN =
  /overloaded_error|"type"\s*:\s*"overloaded_error"|overloaded|at capacity|high demand|high load/i

const RATE_LIMIT_PATTERN =
  /rate[_\s-]?limit|too many requests|\b429\b|requests? per (?:minute|hour|day)|throttl(?:e|ed|ing)|retry after|try again later/i

// User-driven /stop and channel-runner-driven interjection auto-aborts both
// surface as the SDK's "Request was aborted." string. Exported because the
// channel runner's failure-message formatting branches on it too.
export const ABORT_FAILURE_PATTERN = /Request was aborted/i

// HTTP statuses that are deterministic client errors — re-sending the same
// request just fails again, so they are never retried.
const FATAL_HTTP_STATUS = new Set([400, 401, 403, 404, 405, 413, 422])

const FATAL_5XX_REQUEST_VALIDATION_PATTERN =
  /invalid_request_error|unknown parameter|invalid parameter/i

// Node / OS socket error codes meaning "the connection broke" — a transient
// network blip when the endpoint was working moments earlier.
const TRANSIENT_ERROR_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE',
  'EAI_AGAIN', 'ENETUNREACH', 'ENETDOWN', 'EHOSTUNREACH', 'ENOTFOUND',
])

export const RETRY_AFTER_CAP_MS = 60_000

// Deterministic, non-network query failures: a whole-query re-run only
// reproduces them (and a re-run is expensive), so they stay fatal.
const FATAL_MESSAGE_PATTERN = /Exceeded maximum tool turns/i

// Credential / auth-config failures: the model's endpoint has no usable
// credentials (missing, expired, or never imported). Re-sending the identical
// request just reproduces the throw, so retrying wastes turns AND — because
// these carry no HTTP status / socket code — they would otherwise fall through
// to the default-retry branch and surface to the user as "network jitter,
// resend to retry", advice that cannot fix a credential problem. The real fix
// is `/auth import codex` (or restoring the API key), so classify as fatal and
// let the channel render an actionable notice instead of the transient one.
// 2026-06-14 dogfood: a Codex-pinned DM session bricked at boot (expired
// tokens) and showed "本轮因网络抖动中断…可重发消息再试" for a config error.
const CREDENTIAL_FAILURE_PATTERN =
  /No .*credentials stored|credentials (?:are )?(?:missing|expired|unavailable|not (?:found|stored))|\/auth import|Run `codex login`|not authenticated|authentication (?:failed|required)/i

// Provider context-window-overflow errors. The single source of truth for the
// "input is bigger than the model's window" concept, consumed in two places:
//   1. isTransientError() treats it as FATAL — re-sending the same oversized
//      input just reproduces the error, so a plain retry is a wasted round-trip
//      (and on metered providers a wasted ~context-window of billed input).
//   2. The prompt-too-long-retry hook keys on the SAME matcher to run a
//      compaction-then-retry instead of giving up.
// Message-substring match because providers do not all attach a structured
// code: Anthropic says "prompt is too long", OpenAI/codex says "exceeds the
// context window of this model" / "maximum context length is N tokens". A
// provider-specific allowlist that only covered the Anthropic phrasing let the
// codex family slip past the hook (the safety net silently no-op'd) AND fall
// through to the isTransientError default-retry — the 2026-05-30 dogfood
// 250k-input double-overflow on gpt-codex-mid.
const CONTEXT_OVERFLOW_PATTERN =
  /prompt is too long|input is too long|input length|exceeds the context window|context window|context length|exceeds maximum context|maximum context length/i

/**
 * True when the error is a provider "input exceeds the model context window"
 * signal. Shared by isTransientError (→ fatal) and the prompt-too-long-retry
 * hook (→ compact-then-retry). Inspects the error message across the cause
 * chain.
 */
export function isContextOverflowError(error: unknown): boolean {
  for (const node of queryErrorChain(error)) {
    const detail = node instanceof Error ? node.message : String(node)
    if (CONTEXT_OVERFLOW_PATTERN.test(detail)) {
      return true
    }
  }
  return false
}

/**
 * True when the error is a provider credential / auth-config failure (missing
 * or expired API key / OAuth tokens). Shared by `isTransientError` (→ fatal,
 * no retry) and the channel failure formatter (→ actionable "import/refresh
 * credentials" notice instead of the generic "network jitter" one).
 */
export function isCredentialError(error: unknown): boolean {
  for (const node of queryErrorChain(error)) {
    const detail = node instanceof Error ? node.message : String(node)
    if (CREDENTIAL_FAILURE_PATTERN.test(detail)) {
      return true
    }
  }
  return false
}

export class IdleStreamError extends Error {
  readonly kind: 'ttfb' | 'inter-event'
  readonly idleMs: number
  readonly model: string
  readonly endpoint: string

  constructor(input: {
    kind: 'ttfb' | 'inter-event'
    idleMs: number
    model: string
    endpoint: string
  }) {
    super(`stream idle > ${input.idleMs}ms (${input.kind})`)
    this.name = 'IdleStreamError'
    this.kind = input.kind
    this.idleMs = input.idleMs
    this.model = input.model
    this.endpoint = input.endpoint
  }
}

function queryErrorChain(error: unknown): unknown[] {
  const chain: unknown[] = []
  let node: unknown = error
  for (let depth = 0; depth < 6 && node != null; depth += 1) {
    chain.push(node)
    node = (node as { cause?: unknown }).cause
  }
  return chain
}

export function retryAfterMsOf(
  error: unknown,
  capMs = RETRY_AFTER_CAP_MS,
): number | undefined {
  const normalizedCap = Math.max(0, Math.floor(capMs))
  for (const node of queryErrorChain(error)) {
    if (typeof node !== 'object' || node === null) {
      continue
    }
    const retryAfterMs = (node as { retryAfterMs?: unknown }).retryAfterMs
    if (typeof retryAfterMs !== 'number' || !Number.isFinite(retryAfterMs) || retryAfterMs <= 0) {
      continue
    }
    return Math.min(Math.ceil(retryAfterMs), normalizedCap)
  }
  return undefined
}

export function retryDelayMsWithRetryAfter(
  baseDelayMs: number,
  error: unknown,
  capMs = RETRY_AFTER_CAP_MS,
): number {
  const normalizedCap = Math.max(0, Math.floor(capMs))
  const retryAfterMs = retryAfterMsOf(error, normalizedCap) ?? 0
  return Math.min(Math.max(Math.ceil(baseDelayMs), retryAfterMs), normalizedCap)
}

function httpStatusOf(node: unknown): number | undefined {
  if (typeof node !== 'object' || node === null) {
    return undefined
  }
  const obj = node as Record<string, unknown>
  const response = obj.response as Record<string, unknown> | undefined
  for (const candidate of [obj.status, obj.statusCode, response?.status]) {
    if (typeof candidate === 'number' && candidate >= 100 && candidate < 600) {
      return candidate
    }
  }
  return undefined
}

function normalizeErrorTypeToken(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return undefined
  }
  const normalized = String(value).trim().toLowerCase().replace(/[\s-]+/g, '_')
  return normalized || undefined
}

function collectErrorDetailParts(node: unknown, parts: string[], depth = 0): void {
  if (depth > 3 || node == null) {
    return
  }
  if (typeof node === 'string' || typeof node === 'number') {
    parts.push(String(node))
    return
  }
  if (node instanceof Error) {
    parts.push(node.message)
  }
  if (typeof node !== 'object') {
    return
  }
  const obj = node as Record<string, unknown>
  for (const key of ['message', 'type', 'code', 'body']) {
    const value = obj[key]
    if (typeof value === 'string' || typeof value === 'number') {
      parts.push(String(value))
    }
  }
  collectErrorDetailParts(obj.error, parts, depth + 1)
  const response = obj.response as Record<string, unknown> | undefined
  collectErrorDetailParts(response?.error, parts, depth + 1)
  collectErrorDetailParts(response?.data, parts, depth + 1)
  collectErrorDetailParts(response?.body, parts, depth + 1)
}

function errorDetailText(error: unknown): string {
  const parts: string[] = []
  for (const node of queryErrorChain(error)) {
    collectErrorDetailParts(node, parts)
  }
  return parts.join('\n')
}

function errorBodyTypes(error: unknown): string[] {
  const out = new Set<string>()
  for (const node of queryErrorChain(error)) {
    if (typeof node !== 'object' || node === null) {
      continue
    }
    const obj = node as Record<string, unknown>
    const nested = obj.error as Record<string, unknown> | undefined
    const response = obj.response as Record<string, unknown> | undefined
    const responseError = response?.error as Record<string, unknown> | undefined
    const responseData = response?.data as Record<string, unknown> | undefined
    const candidates = [
      obj.type,
      obj.code,
      nested?.type,
      nested?.code,
      responseError?.type,
      responseError?.code,
      responseData?.type,
      responseData?.code,
    ]
    for (const candidate of candidates) {
      const token = normalizeErrorTypeToken(candidate)
      if (token) {
        out.add(token)
      }
    }
  }
  return [...out]
}

function hasQuotaSelfHealSignal(error: unknown): boolean {
  return QUOTA_SELF_HEAL_SIGNAL.test(errorDetailText(error))
}

export function isBillingError(error: unknown): boolean {
  // An explicit billing / quota error.type is unambiguous — being out of
  // credits never self-heals, so it stays fatal regardless of any
  // "retry" / "wait" wording a verbose body (or a transit gateway wrapper)
  // may also carry. Only the message-pattern path below is subject to the
  // self-heal downgrade, mirroring OpenClaw/Hermes (explicit type/code →
  // billing; the "quota resets daily" ambiguity → transient rate-limit).
  for (const type of errorBodyTypes(error)) {
    if (BILLING_ERROR_TYPE.has(type)) {
      return true
    }
  }
  if (BILLING_FAILURE_PATTERN.test(errorDetailText(error))) {
    return !hasQuotaSelfHealSignal(error)
  }
  return false
}

export function isRateLimitError(error: unknown): boolean {
  if (isBillingError(error)) {
    return false
  }
  for (const node of queryErrorChain(error)) {
    const status = httpStatusOf(node)
    if (status === 429) {
      return true
    }
  }
  return RATE_LIMIT_PATTERN.test(errorDetailText(error))
}

function isOverloadedError(error: unknown): boolean {
  return OVERLOADED_PATTERN.test(errorDetailText(error))
}

/** True for /stop and interjection auto-abort — never retried. */
export function isAbortError(error: unknown): boolean {
  for (const node of queryErrorChain(error)) {
    if (
      typeof node === 'object' && node !== null &&
      (node as { name?: unknown }).name === 'AbortError'
    ) {
      return true
    }
  }
  const detail = error instanceof Error ? error.message : String(error)
  return ABORT_FAILURE_PATTERN.test(detail)
}

/**
 * Decide whether a query() / streamChat throw should be retried. Inspects the
 * error object and its `cause` chain — HTTP status, Node/undici socket
 * `code`, error `name` — instead of regexing the message string, so whole
 * CLASSES of transient failures are caught without an exact-string allowlist
 * (the gap that misclassified the undici `TypeError: terminated` from the
 * 2026-05-21 dogfood as fatal).
 *
 * A genuinely unrecognized error defaults to `true` (retry). That can never
 * loop: every caller hard-caps attempts (query.ts's per-turn loop and the
 * channel runner's MAX_QUERY_RETRIES), so a truly fatal error just fails
 * honestly after the cap — while a wrongly-given-up transient error costs a
 * whole dead turn the user must redo. Abort (/stop) and deterministic client
 * errors (4xx, "Exceeded maximum tool turns") are the explicit non-retry
 * cases.
 */
export function isTransientError(error: unknown): boolean {
  if (error instanceof IdleStreamError) {
    return true
  }
  if (isAbortError(error)) {
    return false
  }
  const detail = error instanceof Error ? error.message : String(error)
  if (FATAL_MESSAGE_PATTERN.test(detail)) {
    return false
  }
  // Context-window overflow is deterministic: the same oversized input fails
  // again. The prompt-too-long-retry hook (which compacts THEN retries) runs
  // before this classifier in query.ts; if it could not recover, a plain retry
  // here would only re-send the identical input and waste a round-trip.
  if (isContextOverflowError(error)) {
    return false
  }
  // Missing / expired credentials are deterministic config errors: a retry
  // re-sends the same request and fails the same way. Fatal so the channel
  // surfaces an actionable notice rather than retrying + "resend to retry".
  if (isCredentialError(error)) {
    return false
  }
  if (isBillingError(error)) {
    return false
  }
  for (const node of queryErrorChain(error)) {
    const status = httpStatusOf(node)
    if (status !== undefined) {
      if (status === 402) {
        return hasQuotaSelfHealSignal(error)
      }
      if (FATAL_HTTP_STATUS.has(status)) {
        return false
      }
      if (
        (status === 500 || status === 502) &&
        FATAL_5XX_REQUEST_VALIDATION_PATTERN.test(errorDetailText(error))
      ) {
        return false
      }
      if (status === 408 || status === 429 || status >= 500) {
        return true
      }
    }
    if (typeof node === 'object' && node !== null) {
      const code = (node as { code?: unknown }).code
      if (
        typeof code === 'string' &&
        (TRANSIENT_ERROR_CODES.has(code) || code.startsWith('UND_ERR'))
      ) {
        return true
      }
    }
  }
  // Overloaded (Anthropic 529 / "overloaded_error") is checked AFTER the
  // status loop so an explicit FATAL_HTTP_STATUS 4xx whose body merely mentions
  // "overloaded" / "high demand" stays fatal. A 529 is already retried via the
  // `>=500` branch above; this backstop only catches a status-less streaming
  // error frame that carries the overloaded marker in its body text.
  if (isOverloadedError(error)) {
    return true
  }
  if (TRANSIENT_FAILURE_PATTERN.test(detail)) {
    return true
  }
  // Unrecognized — default to retry (every caller hard-caps the attempts).
  return true
}
