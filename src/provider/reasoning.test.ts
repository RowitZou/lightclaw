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
})
