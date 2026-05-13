import {
  classifyFeishuError,
  FeishuApiError,
  type FeishuErrorClassification,
} from './errors.js'

export interface FeishuRetryOptions {
  maxAttempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  shouldRetry?: (c: FeishuErrorClassification, attempt: number) => boolean
  onRetry?: (c: FeishuErrorClassification, attempt: number, delayMs: number) => void
  /**
   * Out-param incremented once per backoff sleep. After the call returns,
   * `retryCounter.count` equals the number of retries actually performed
   * (0 on first-try success; up to maxAttempts-1 on budget-exhausted failure).
   * Pass a fresh `{ count: 0 }` per call and read from the same reference
   * after the await. Helpers that compose multiple withFeishuRetry sub-calls
   * (e.g. createDoc + appendDocText inside one operation) can share one
   * counter so the audit captures the union of retries.
   */
  retryCounter?: { count: number }
}

const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_BASE_DELAY_MS = 500
const DEFAULT_MAX_DELAY_MS = 8000

export async function withFeishuRetry<T>(
  fn: () => Promise<T>,
  opts: FeishuRetryOptions = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS
  const maxDelayMs = opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS
  let lastClassification: FeishuErrorClassification | undefined

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn()
    } catch (error) {
      const classification = error instanceof FeishuApiError
        ? error.classification
        : classifyFeishuError(error)
      lastClassification = classification
      const shouldRetry = opts.shouldRetry
        ? opts.shouldRetry(classification, attempt)
        : classification.retryable
      if (!shouldRetry || attempt >= maxAttempts) {
        throw error
      }
      const delayMs = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs)
      opts.onRetry?.(classification, attempt, delayMs)
      if (opts.retryCounter) opts.retryCounter.count += 1
      await delay(delayMs)
    }
  }

  throw new FeishuApiError(lastClassification ?? classifyFeishuError(new Error('Feishu retry exhausted')))
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
