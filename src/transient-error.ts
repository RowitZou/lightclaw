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

// User-driven /stop and channel-runner-driven interjection auto-aborts both
// surface as the SDK's "Request was aborted." string. Exported because the
// channel runner's failure-message formatting branches on it too.
export const ABORT_FAILURE_PATTERN = /Request was aborted/i

// HTTP statuses that are deterministic client errors — re-sending the same
// request just fails again, so they are never retried.
const FATAL_HTTP_STATUS = new Set([400, 401, 403, 404, 405, 413, 422])

// Node / OS socket error codes meaning "the connection broke" — a transient
// network blip when the endpoint was working moments earlier.
const TRANSIENT_ERROR_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE',
  'EAI_AGAIN', 'ENETUNREACH', 'ENETDOWN', 'EHOSTUNREACH', 'ENOTFOUND',
])

// Deterministic, non-network query failures: a whole-query re-run only
// reproduces them (and a re-run is expensive), so they stay fatal.
const FATAL_MESSAGE_PATTERN = /Exceeded maximum tool turns/i

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
  for (const node of queryErrorChain(error)) {
    const status = httpStatusOf(node)
    if (status !== undefined) {
      if (FATAL_HTTP_STATUS.has(status)) {
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
  if (TRANSIENT_FAILURE_PATTERN.test(detail)) {
    return true
  }
  // Unrecognized — default to retry (every caller hard-caps the attempts).
  return true
}
