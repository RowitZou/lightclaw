import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { estimateMessageTokens } from './token-estimate.js'
import type { Message } from './types.js'

function userImageMessage(base64Length: number): Message {
  return {
    type: 'user',
    uuid: 'test',
    parentUuid: null,
    timestamp: 0,
    message: {
      role: 'user',
      content: [
        {
          type: 'image',
          source: {
            type: 'base64',
            mediaType: 'image/jpeg',
            data: 'x'.repeat(base64Length),
          },
        },
      ],
    },
  }
}

function userDocumentMessage(base64Length: number): Message {
  return {
    type: 'user',
    uuid: 'test',
    parentUuid: null,
    timestamp: 0,
    message: {
      role: 'user',
      content: [
        {
          type: 'document',
          source: {
            type: 'base64',
            mediaType: 'application/pdf',
            data: 'x'.repeat(base64Length),
          },
        },
      ],
    },
  }
}

describe('estimateMessageTokens — media cap', () => {
  it('caps image estimate at 2000 tokens regardless of base64 size', () => {
    // An 8 MB base64 image would have been charged ~512k tokens under the
    // legacy length/16 formula. Cap brings it to 2000 + tiny envelope.
    const huge = estimateMessageTokens(userImageMessage(8_000_000))
    assert.ok(huge <= 2010, `expected ≤ 2010, got ${huge}`)
    assert.ok(huge >= 2000, `expected ≥ 2000 (hit cap), got ${huge}`)
  })

  it('scales small images proportionally instead of always charging the cap', () => {
    const small = estimateMessageTokens(userImageMessage(6400))
    // 6400 / 64 = 100 tokens, plus 4-byte envelope.
    assert.ok(small <= 110, `expected ≤ 110, got ${small}`)
    assert.ok(small >= 100, `expected ≥ 100, got ${small}`)
  })

  it('caps document estimate at 50_000 tokens', () => {
    // 80 MB base64 PDF — way beyond the cap.
    const huge = estimateMessageTokens(userDocumentMessage(80_000_000))
    assert.ok(huge <= 50_010, `expected ≤ 50_010, got ${huge}`)
    assert.ok(huge >= 50_000, `expected ≥ 50_000 (hit cap), got ${huge}`)
  })

  it('scales medium documents proportionally', () => {
    // ~8 MB PDF base64: was ~515k tokens under length/16. New: 8M/800 = 10000.
    const eightMb = estimateMessageTokens(userDocumentMessage(8_000_000))
    assert.ok(eightMb <= 10_100, `expected ≤ 10_100, got ${eightMb}`)
    assert.ok(eightMb >= 10_000, `expected ≥ 10_000, got ${eightMb}`)
  })
})
