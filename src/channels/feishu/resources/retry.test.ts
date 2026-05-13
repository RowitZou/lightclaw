import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { FeishuApiError, type FeishuErrorClassification } from './errors.js'
import { withFeishuRetry } from './retry.js'

describe('withFeishuRetry', () => {
  it('retries retryable FeishuApiError and returns success', async () => {
    let calls = 0
    const retries: Array<{ attempt: number; delayMs: number }> = []
    const result = await withFeishuRetry(async () => {
      calls += 1
      if (calls === 1) throw new FeishuApiError(classification('rate-limited', true))
      return 'ok'
    }, {
      baseDelayMs: 1,
      onRetry: (_c, attempt, delayMs) => retries.push({ attempt, delayMs }),
    })
    assert.equal(result, 'ok')
    assert.equal(calls, 2)
    assert.deepEqual(retries, [{ attempt: 1, delayMs: 1 }])
  })

  it('throws after retry budget is exhausted', async () => {
    let calls = 0
    await assert.rejects(
      withFeishuRetry(async () => {
        calls += 1
        throw new FeishuApiError(classification('rate-limited', true))
      }, { baseDelayMs: 1 }),
      FeishuApiError,
    )
    assert.equal(calls, 3)
  })

  it('does not retry non-retryable errors', async () => {
    let calls = 0
    await assert.rejects(
      withFeishuRetry(async () => {
        calls += 1
        throw new FeishuApiError(classification('validation-failed', false))
      }, { baseDelayMs: 1 }),
      FeishuApiError,
    )
    assert.equal(calls, 1)
  })

  it('classifies raw transient network errors as retryable', async () => {
    let calls = 0
    const result = await withFeishuRetry(async () => {
      calls += 1
      if (calls === 1) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
      return 'ok'
    }, { baseDelayMs: 1 })
    assert.equal(result, 'ok')
    assert.equal(calls, 2)
  })

  it('allows shouldRetry override', async () => {
    let calls = 0
    const result = await withFeishuRetry(async () => {
      calls += 1
      if (calls === 1) throw new FeishuApiError(classification('validation-failed', false))
      return 'ok'
    }, {
      baseDelayMs: 1,
      shouldRetry: (_c, attempt) => attempt === 1,
    })
    assert.equal(result, 'ok')
    assert.equal(calls, 2)
  })

  it('increments retryCounter once per backoff', async () => {
    const retryCounter = { count: 0 }
    let calls = 0
    const result = await withFeishuRetry(async () => {
      calls += 1
      if (calls < 3) throw new FeishuApiError(classification('rate-limited', true))
      return 'ok'
    }, { baseDelayMs: 1, retryCounter })
    assert.equal(result, 'ok')
    assert.equal(retryCounter.count, 2)
  })

  it('retryCounter reflects budget-exhausted failure', async () => {
    const retryCounter = { count: 0 }
    await assert.rejects(
      withFeishuRetry(async () => {
        throw new FeishuApiError(classification('rate-limited', true))
      }, { baseDelayMs: 1, retryCounter }),
      FeishuApiError,
    )
    // 3 attempts, 2 backoffs slept through (the 3rd attempt's failure throws without sleeping).
    assert.equal(retryCounter.count, 2)
  })
})

function classification(kind: FeishuErrorClassification['kind'], retryable: boolean): FeishuErrorClassification {
  return {
    kind,
    retryable,
    admin: false,
    agentMessage: `Feishu API error [${kind}]`,
    adminMessage: `Feishu API error [${kind}]`,
  }
}
