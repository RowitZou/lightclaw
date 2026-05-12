import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { mapUsage } from './openai.js'

describe('openai: mapUsage', () => {
  it('extracts input_tokens from prompt_tokens and output_tokens from completion_tokens', () => {
    const result = mapUsage({ prompt_tokens: 1234, completion_tokens: 56 })
    assert.deepEqual(result, { input_tokens: 1234, output_tokens: 56 })
  })

  it('surfaces prompt_tokens_details.cached_tokens as cache_read_input_tokens', () => {
    const result = mapUsage({
      prompt_tokens: 1000,
      completion_tokens: 100,
      prompt_tokens_details: { cached_tokens: 750 },
    })
    assert.equal(result.input_tokens, 1000)
    assert.equal(result.output_tokens, 100)
    assert.equal(result.cache_read_input_tokens, 750)
    // OpenAI has no explicit cache-creation step; this field must stay absent.
    assert.equal(result.cache_creation_input_tokens, undefined)
  })

  it('leaves cache_read_input_tokens absent when prompt_tokens_details is missing', () => {
    const result = mapUsage({ prompt_tokens: 100, completion_tokens: 10 })
    assert.equal(result.cache_read_input_tokens, undefined)
  })

  it('leaves cache_read_input_tokens absent when cached_tokens is not a number', () => {
    const result = mapUsage({
      prompt_tokens: 100,
      completion_tokens: 10,
      prompt_tokens_details: { cached_tokens: 'lots' },
    })
    assert.equal(result.cache_read_input_tokens, undefined)
  })

  it('returns empty object for non-record input', () => {
    assert.deepEqual(mapUsage(null), {})
    assert.deepEqual(mapUsage(undefined), {})
    assert.deepEqual(mapUsage(42), {})
  })

  it('tolerates partial usage with only cache field populated', () => {
    const result = mapUsage({ prompt_tokens_details: { cached_tokens: 50 } })
    assert.equal(result.cache_read_input_tokens, 50)
    assert.equal(result.input_tokens, undefined)
    assert.equal(result.output_tokens, undefined)
  })
})
