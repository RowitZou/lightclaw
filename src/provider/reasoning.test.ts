import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { anthropicEffort, isReasoningUnsupportedError } from './reasoning.js'

describe('reasoning: anthropicEffort mapping', () => {
  it("maps 'none' to null (caller omits thinking + output_config → reasoning off)", () => {
    assert.equal(anthropicEffort('none'), null)
  })

  it("clamps 'minimal' to 'low' (Anthropic has no minimal tier)", () => {
    assert.equal(anthropicEffort('minimal'), 'low')
  })

  it('passes low / medium / high / xhigh through unchanged', () => {
    assert.equal(anthropicEffort('low'), 'low')
    assert.equal(anthropicEffort('medium'), 'medium')
    assert.equal(anthropicEffort('high'), 'high')
    assert.equal(anthropicEffort('xhigh'), 'xhigh')
  })
})

describe('reasoning: isReasoningUnsupportedError discrimination', () => {
  it('matches a 4xx that names reasoning_effort', () => {
    assert.equal(
      isReasoningUnsupportedError(
        Object.assign(new Error("Unsupported parameter: 'reasoning_effort'"), {
          status: 400,
        }),
      ),
      true,
    )
  })

  it('matches a 4xx that names output_config', () => {
    assert.equal(
      isReasoningUnsupportedError(
        Object.assign(new Error('output_config is not supported on this model'), {
          status: 400,
        }),
      ),
      true,
    )
  })

  it('matches a loose effort/thinking-unsupported phrasing', () => {
    assert.equal(
      isReasoningUnsupportedError(
        Object.assign(new Error('this model does not support extended thinking'), {
          status: 400,
        }),
      ),
      true,
    )
  })

  it('does NOT match a 5xx even if it mentions reasoning (that is the transient path)', () => {
    assert.equal(
      isReasoningUnsupportedError(
        Object.assign(new Error('reasoning_effort internal server error'), {
          status: 503,
        }),
      ),
      false,
    )
  })

  it('does NOT match an unrelated 4xx (bad model id) — must not be swallowed as a reasoning strip', () => {
    assert.equal(
      isReasoningUnsupportedError(
        Object.assign(new Error('model "gpt-nope" not found'), { status: 404 }),
      ),
      false,
    )
  })

  it('does NOT match a field name without an unsupported marker', () => {
    // "reasoning" appears but nothing says it is unsupported — could be any
    // 400. Stripping reasoning here would mask the real error.
    assert.equal(
      isReasoningUnsupportedError(
        Object.assign(new Error('your reasoning request was rate limited'), {
          status: 400,
        }),
      ),
      false,
    )
  })

  // Review §3.11a regressions: the loose tier used to accept status-less
  // wrapped transport errors and the generic 'unexpected' marker. A transient
  // network error phrased like "unexpected error while processing reasoning"
  // then triggered the strip-retry, and when the retry succeeded on the
  // transient's clearance, (baseUrl, model) was PERMANENTLY memoed as
  // reasoning-unsupported (the memo is only ever set ON) — a one-off blip
  // silently disabled thinking forever.

  it('loose tier does NOT match a wrapped error without a numeric status', () => {
    assert.equal(
      isReasoningUnsupportedError(
        new Error('unsupported state: fetch failed while streaming reasoning tokens'),
      ),
      false,
    )
  })

  it("loose tier does NOT match on 'unexpected' — proxies use it for generic transient wrappers", () => {
    assert.equal(
      isReasoningUnsupportedError(
        Object.assign(new Error('unexpected error while processing reasoning request'), {
          status: 400,
        }),
      ),
      false,
    )
  })

  it('exact field names still match WITHOUT a numeric status (unambiguous even when wrapped)', () => {
    assert.equal(
      isReasoningUnsupportedError(
        new Error("request failed: Unsupported parameter: 'reasoning_effort'"),
      ),
      true,
    )
  })
})
