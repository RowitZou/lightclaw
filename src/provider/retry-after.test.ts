import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  attachProviderRetryAfter,
  extractProviderRetryAfterMs,
} from './retry-after.js'
import { formatOpenAIAuthError } from './openai-auth.js'
import { retryAfterMsOf } from '../transient-error.js'

describe('provider Retry-After extraction', () => {
  it('reads retry-after seconds from an Anthropic SDK-shaped .headers error', () => {
    const sdkError = Object.assign(new Error('rate limited'), {
      status: 429,
      headers: new Headers({ 'retry-after': '3' }),
    })

    assert.equal(extractProviderRetryAfterMs(sdkError), 3_000)
  })

  it('reads retry-after-ms from an OpenAI SDK-shaped .headers error', () => {
    const sdkError = Object.assign(new Error('rate limited'), {
      status: 429,
      headers: new Headers({ 'retry-after-ms': '2500' }),
    })

    assert.equal(extractProviderRetryAfterMs(sdkError), 2_500)
  })

  it('reads retry-after HTTP-date from an openai-auth .response.headers error', () => {
    const nowMs = Date.parse('2026-06-18T00:00:00.000Z')
    const sdkError = {
      status: 429,
      response: {
        headers: new Headers({
          'retry-after': 'Thu, 18 Jun 2026 00:00:04 GMT',
        }),
      },
      error: { type: 'rate_limit_error', message: 'rate limited' },
    }

    assert.equal(extractProviderRetryAfterMs(sdkError, nowMs), 4_000)
  })

  it('attaches retryAfterMs to the provider error object', () => {
    const sdkError = Object.assign(new Error('rate limited'), {
      headers: new Headers({ 'retry-after': '5' }),
    })

    const attached = attachProviderRetryAfter(sdkError)

    assert.equal((attached as Error & { retryAfterMs?: number }).retryAfterMs, 5_000)
  })

  it('formatOpenAIAuthError preserves openai-auth retry-after on the wrapped error', () => {
    const wrapped = formatOpenAIAuthError('OpenAI Responses streamChat request failed', {
      status: 429,
      response: {
        headers: new Headers({ 'retry-after-ms': '7000' }),
      },
      error: { type: 'rate_limit_error', message: 'rate limited' },
    })

    assert.equal(retryAfterMsOf(wrapped), 7_000)
  })
})
