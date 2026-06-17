import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { mapUsage } from './openai.js'

describe('openai: mapUsage', () => {
  it('extracts input_tokens from prompt_tokens and output_tokens from completion_tokens', () => {
    const result = mapUsage({ prompt_tokens: 1234, completion_tokens: 56 })
    assert.deepEqual(result, { input_tokens: 1234, output_tokens: 56 })
  })

  it('surfaces cached_tokens as cache_read and subtracts it from input_tokens (disjoint)', () => {
    const result = mapUsage({
      prompt_tokens: 1000,
      completion_tokens: 100,
      prompt_tokens_details: { cached_tokens: 750 },
    })
    // OpenAI `prompt_tokens` (1000) is the TOTAL input-side count and
    // `cached_tokens` (750) is a SUBSET of it. The canonical shape is disjoint
    // (input + cache_read + cache_create), so input_tokens must be the fresh
    // remainder 1000 - 750 = 250 — NOT 1000 (which would double-count the
    // cached tokens and understate every downstream cache-hit / cost figure).
    assert.equal(result.input_tokens, 250)
    assert.equal(result.output_tokens, 100)
    assert.equal(result.cache_read_input_tokens, 750)
    // input + cache_read reconstructs the original prompt_tokens total.
    assert.equal((result.input_tokens ?? 0) + (result.cache_read_input_tokens ?? 0), 1000)
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
