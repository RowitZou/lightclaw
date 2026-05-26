import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateProjectedInputTokens,
} from './token-estimate.js'
import type { AssistantMessage, Message, UserMessage } from './types.js'

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

function userTextMessage(text: string): UserMessage {
  return {
    type: 'user',
    uuid: 'u',
    parentUuid: null,
    timestamp: 0,
    message: { role: 'user', content: text },
  }
}

function assistantTextMessage(text: string, inputTokens?: number): AssistantMessage {
  return {
    type: 'assistant',
    uuid: 'a',
    parentUuid: null,
    timestamp: 0,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      usage: inputTokens === undefined ? {} : { input_tokens: inputTokens },
    },
  }
}

describe('estimateProjectedInputTokens — anchor + delta calibration', () => {
  it('falls back to estimateMessagesTokens when no assistant usage anchor exists', () => {
    // Cold start: only user messages, or assistant messages without usage.
    const msgs: Message[] = [userTextMessage('hello world')]
    assert.equal(
      estimateProjectedInputTokens(msgs),
      estimateMessagesTokens(msgs),
    )

    const msgsWithUsagelessAssistant: Message[] = [
      userTextMessage('hi'),
      assistantTextMessage('hi back'),
    ]
    assert.equal(
      estimateProjectedInputTokens(msgsWithUsagelessAssistant),
      estimateMessagesTokens(msgsWithUsagelessAssistant),
    )
  })

  it('ignores assistant messages whose input_tokens is 0 or missing', () => {
    // Bare-error assistant turns persist `usage: {}` (see line 1 of the
    // dogfood transcript: "Codex refresh token was rejected"). Those have
    // no useful anchor; the estimator must fall through.
    const msgs: Message[] = [
      userTextMessage('hello'),
      assistantTextMessage('error', 0),
      userTextMessage('retry'),
    ]
    assert.equal(
      estimateProjectedInputTokens(msgs),
      estimateMessagesTokens(msgs),
    )
  })

  it('uses real input_tokens as baseline plus estimate of the anchor and tail', () => {
    // Anchor reports the real prompt token count the wire produced; the
    // anchor itself + everything after still has to be estimated since it
    // has not been sent yet. With ratio == 1 (anchor.input_tokens equals
    // local prefix estimate), the projection is exactly
    //   anchorInput + estimate(anchor + tail).
    const prefixMsg = userTextMessage('AAA') // tiny prefix
    const prefixEst = estimateMessagesTokens([prefixMsg])
    const anchor = assistantTextMessage('reply text', prefixEst) // ratio = 1.0
    const tail = userTextMessage('next user turn')
    const msgs: Message[] = [prefixMsg, anchor, tail]
    const expected =
      prefixEst
      + estimateMessageTokens(anchor)
      + estimateMessageTokens(tail)
    assert.equal(estimateProjectedInputTokens(msgs), expected)
  })

  it('applies prefix-derived calibration to anchor + tail estimate', () => {
    // The codex / multimodal dogfood case: estimator underestimates real
    // wire by ~2x. Anchor input_tokens encodes that ratio; the tail
    // estimate must be scaled by it so the threshold judgement reflects
    // real upstream pressure.
    const prefix = userTextMessage('one'.repeat(64)) // some prefix tokens
    const prefixEst = estimateMessagesTokens([prefix])
    const realInput = prefixEst * 2 // 2x underestimate
    const anchor = assistantTextMessage('done', realInput)
    const tail = userTextMessage('follow-up message here')
    const projected = estimateProjectedInputTokens([prefix, anchor, tail])

    const naive = estimateMessagesTokens([prefix, anchor, tail])
    // Projection must be substantially bigger than the naive local-only
    // estimate when the session has demonstrated a >1 ratio. Bounds
    // sanity-check rather than computing the exact constant so future
    // estimator tweaks don't churn this assertion.
    assert.ok(
      projected > naive,
      `expected projection ${projected} > naive estimate ${naive} for 2x-underestimating session`,
    )
    // Lower bound: at least anchorInput + (estimate(anchor + tail) * 1.5).
    const tailEst = estimateMessageTokens(anchor) + estimateMessageTokens(tail)
    assert.ok(
      projected >= realInput + Math.ceil(tailEst * 1.5),
      `expected ${projected} >= ${realInput + Math.ceil(tailEst * 1.5)}`,
    )
  })

  it('picks the most recent assistant usage as the anchor', () => {
    // Two assistant turns: only the last one's input_tokens is used.
    const m0 = userTextMessage('first ask')
    const a0 = assistantTextMessage('first reply', 100)
    const m1 = userTextMessage('second ask')
    const a1 = assistantTextMessage('second reply', 250)
    const m2 = userTextMessage('third ask')
    const msgs: Message[] = [m0, a0, m1, a1, m2]
    const projected = estimateProjectedInputTokens(msgs)
    // Anchor is a1 (idx 3). Prefix to estimate ratio against is [m0, a0, m1].
    // Lower bound: at least the anchor input (250). Cannot exceed
    // anchorInput + (delta estimate * 5x clamp).
    assert.ok(projected >= 250, `expected projection >= 250, got ${projected}`)
    const deltaEst = estimateMessageTokens(a1) + estimateMessageTokens(m2)
    assert.ok(
      projected <= 250 + deltaEst * 5 + 1,
      `expected projection <= ${250 + deltaEst * 5 + 1}, got ${projected}`,
    )
  })

  it('clamps the calibration multiplier into [0.5, 5.0]', () => {
    // Ratio that would otherwise be 100x — must be capped at 5x so a
    // pathological anchor (e.g. a stale recovered transcript) can't blow
    // the projection up to infinity.
    const prefix = userTextMessage('x')
    const prefixEst = estimateMessagesTokens([prefix])
    const anchor = assistantTextMessage('reply', prefixEst * 100)
    const tail = userTextMessage('y'.repeat(80))
    const projected = estimateProjectedInputTokens([prefix, anchor, tail])
    const tailEst = estimateMessageTokens(anchor) + estimateMessageTokens(tail)
    // Upper bound: anchorInput + tailEst * 5 (+ a small slack for ceil).
    assert.ok(
      projected <= prefixEst * 100 + tailEst * 5 + 1,
      `expected ${projected} <= ${prefixEst * 100 + tailEst * 5 + 1}`,
    )
  })

  it('uses calibration 1.0 when the prefix estimate is zero', () => {
    // Pathological: anchor sits at idx 0 with an empty prefix slice. There
    // is no ratio to derive; fall back to neutral multiplier so we still
    // return something sensible (anchorInput + tail estimate).
    const anchor = assistantTextMessage('first', 42)
    const tail = userTextMessage('next')
    const msgs: Message[] = [anchor, tail]
    const expected =
      42 + estimateMessageTokens(anchor) + estimateMessageTokens(tail)
    assert.equal(estimateProjectedInputTokens(msgs), expected)
  })
})

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
