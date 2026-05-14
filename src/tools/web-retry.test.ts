import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  isRetryableHttpStatus,
  isTransientNetworkError,
  WebRetryableHttpError,
  withWebRetry,
} from './web-retry.js'

/** axios-shaped error: `.code` set, optionally `.response.status`. */
function axiosLikeError(opts: {
  code?: string
  message?: string
  status?: number
  name?: string
}): Error {
  const err = new Error(opts.message ?? 'stub error')
  if (opts.name) err.name = opts.name
  Object.assign(err, {
    code: opts.code,
    response: opts.status === undefined ? undefined : { status: opts.status },
  })
  return err
}

/** Silent onRetry so the retry-path tests don't spam the suite's stderr.
 *  Recovery lines (printed on success-after-retry) still surface — that is
 *  intentional, they are useful and rare. */
const SILENT = (): void => {}

describe('isTransientNetworkError', () => {
  it('the 2026-05-14 dogfood error (socket disconnect before TLS) is transient', () => {
    // This exact string has no stable `.code` once it crosses axios +
    // https-proxy-agent — the message-fragment fallback is what catches it.
    const err = new Error(
      'Client network socket disconnected before secure TLS connection was established',
    )
    assert.equal(isTransientNetworkError(err), true)
  })

  it('socket-level error codes are transient', () => {
    for (const code of [
      'ECONNRESET',
      'ECONNREFUSED',
      'EPIPE',
      'ENETUNREACH',
      'EHOSTUNREACH',
      'ETIMEDOUT',
      'EAI_AGAIN',
      'ERR_SOCKET_CONNECTION_TIMEOUT',
    ]) {
      assert.equal(
        isTransientNetworkError(axiosLikeError({ code })),
        true,
        `${code} should be transient`,
      )
    }
  })

  it('axios timeout (ECONNABORTED) is NOT transient — the budget was already spent', () => {
    assert.equal(
      isTransientNetworkError(
        axiosLikeError({ code: 'ECONNABORTED', message: 'timeout of 60000ms exceeded' }),
      ),
      false,
    )
  })

  it('DNS miss (ENOTFOUND) is NOT transient — it is a real config error', () => {
    assert.equal(isTransientNetworkError(axiosLikeError({ code: 'ENOTFOUND' })), false)
  })

  it('abort / cancellation is NOT transient under any of its alias names', () => {
    assert.equal(
      isTransientNetworkError(axiosLikeError({ name: 'CanceledError' })),
      false,
    )
    assert.equal(
      isTransientNetworkError(axiosLikeError({ name: 'AbortError' })),
      false,
    )
    assert.equal(
      isTransientNetworkError(axiosLikeError({ code: 'ERR_CANCELED' })),
      false,
    )
    assert.equal(
      isTransientNetworkError(axiosLikeError({ code: 'ABORT_ERR' })),
      false,
    )
  })

  it('HTTP 502/503/504 (via .response.status) are transient; 500/429/404 are not', () => {
    assert.equal(isTransientNetworkError(axiosLikeError({ status: 502 })), true)
    assert.equal(isTransientNetworkError(axiosLikeError({ status: 503 })), true)
    assert.equal(isTransientNetworkError(axiosLikeError({ status: 504 })), true)
    assert.equal(isTransientNetworkError(axiosLikeError({ status: 500 })), false)
    assert.equal(isTransientNetworkError(axiosLikeError({ status: 429 })), false)
    assert.equal(isTransientNetworkError(axiosLikeError({ status: 404 })), false)
  })

  it('WebRetryableHttpError is transient; a plain Error / non-object is not', () => {
    assert.equal(
      isTransientNetworkError(new WebRetryableHttpError(503, 'upstream blip')),
      true,
    )
    assert.equal(isTransientNetworkError(new Error('something else')), false)
    assert.equal(isTransientNetworkError(null), false)
    assert.equal(isTransientNetworkError(undefined), false)
    assert.equal(isTransientNetworkError('a string'), false)
  })
})

describe('isRetryableHttpStatus', () => {
  it('only 502/503/504', () => {
    assert.equal(isRetryableHttpStatus(502), true)
    assert.equal(isRetryableHttpStatus(503), true)
    assert.equal(isRetryableHttpStatus(504), true)
    assert.equal(isRetryableHttpStatus(500), false)
    assert.equal(isRetryableHttpStatus(429), false)
    assert.equal(isRetryableHttpStatus(200), false)
  })
})

describe('withWebRetry', () => {
  it('first-try success: calls fn once, no retry', async () => {
    let calls = 0
    const result = await withWebRetry(
      async () => {
        calls += 1
        return 'ok'
      },
      { label: 'test' },
    )
    assert.equal(result, 'ok')
    assert.equal(calls, 1)
  })

  it('transient error then success: retries and recovers', async () => {
    let calls = 0
    const result = await withWebRetry(
      async () => {
        calls += 1
        if (calls === 1) throw axiosLikeError({ code: 'ECONNRESET' })
        return 'recovered'
      },
      { label: 'test', baseDelayMs: 1, maxDelayMs: 2, onRetry: SILENT },
    )
    assert.equal(result, 'recovered')
    assert.equal(calls, 2)
  })

  it('transient error every time: exhausts maxAttempts and throws the last error', async () => {
    let calls = 0
    await assert.rejects(
      () =>
        withWebRetry(
          async () => {
            calls += 1
            throw axiosLikeError({
              code: 'ECONNRESET',
              message: `attempt ${calls} reset`,
            })
          },
          { label: 'test', baseDelayMs: 1, maxDelayMs: 2, onRetry: SILENT },
        ),
      /attempt 3 reset/,
    )
    // default maxAttempts is 3 → fn invoked 3 times total (1 + 2 retries)
    assert.equal(calls, 3)
  })

  it('non-retryable error: throws immediately, fn called once', async () => {
    let calls = 0
    await assert.rejects(
      () =>
        withWebRetry(
          async () => {
            calls += 1
            throw axiosLikeError({ status: 404, message: 'HTTP 404 Not Found' })
          },
          { label: 'test', baseDelayMs: 1, onRetry: SILENT },
        ),
      /HTTP 404/,
    )
    assert.equal(calls, 1)
  })

  it('abort error: never retried even though attempts remain', async () => {
    let calls = 0
    await assert.rejects(
      () =>
        withWebRetry(
          async () => {
            calls += 1
            throw axiosLikeError({ name: 'CanceledError', message: 'canceled' })
          },
          { label: 'test', baseDelayMs: 1, onRetry: SILENT },
        ),
      /canceled/,
    )
    assert.equal(calls, 1)
  })

  it('WebRetryableHttpError (502/503/504 path): retried', async () => {
    let calls = 0
    const result = await withWebRetry(
      async () => {
        calls += 1
        if (calls < 3) throw new WebRetryableHttpError(503, 'Service Unavailable')
        return 'up'
      },
      { label: 'test', baseDelayMs: 1, maxDelayMs: 2, onRetry: SILENT },
    )
    assert.equal(result, 'up')
    assert.equal(calls, 3)
  })

  it('signal already aborted: throws before the first attempt, fn never called', async () => {
    let calls = 0
    const ctrl = new AbortController()
    ctrl.abort()
    await assert.rejects(
      () =>
        withWebRetry(
          async () => {
            calls += 1
            return 'should not run'
          },
          { label: 'test', signal: ctrl.signal },
        ),
      /test aborted/,
    )
    assert.equal(calls, 0)
  })

  it('abort during backoff: wakes early and throws aborted on the next iteration', async () => {
    let calls = 0
    const ctrl = new AbortController()
    await assert.rejects(
      () =>
        withWebRetry(
          async () => {
            calls += 1
            throw axiosLikeError({ code: 'ECONNRESET' })
          },
          {
            label: 'test',
            signal: ctrl.signal,
            // long backoff so the test would hang if abort did not wake it
            baseDelayMs: 60_000,
            maxDelayMs: 60_000,
            // abort mid-backoff, right after the first failure
            onRetry: () => ctrl.abort(),
          },
        ),
      /test aborted/,
    )
    // fn ran once; the second iteration short-circuited on signal.aborted
    assert.equal(calls, 1)
  })

  it('onRetry receives the error, attempt number, and delay', async () => {
    const seen: Array<{ attempt: number; delayMs: number; msg: string }> = []
    await withWebRetry(
      async () => {
        if (seen.length < 2) throw axiosLikeError({ code: 'ECONNRESET', message: 'reset' })
        return 'ok'
      },
      {
        label: 'test',
        baseDelayMs: 1,
        maxDelayMs: 2,
        onRetry: (err, attempt, delayMs) => {
          seen.push({
            attempt,
            delayMs,
            msg: err instanceof Error ? err.message : String(err),
          })
        },
      },
    )
    assert.equal(seen.length, 2)
    assert.deepEqual(
      seen.map((s) => s.attempt),
      [1, 2],
    )
    assert.ok(seen.every((s) => s.delayMs >= 1))
    assert.ok(seen.every((s) => s.msg === 'reset'))
  })
})
