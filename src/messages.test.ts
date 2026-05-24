import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  createAssistantMessage,
  createSystemCompactMessage,
  createUserMessage,
  toApiMessages,
} from './messages.js'

describe('toApiMessages', () => {
  it('emits the compact boundary summary verbatim without a wire-side prefix', () => {
    // The continuation header is baked into the summary by
    // formatCompactBoundaryText (session/compact.ts). A wire-side
    // "Previous conversation summary:" prefix would stack a second header
    // on top of it.
    const summary = [
      'This session continues from a previous conversation that was compacted to fit context.',
      '',
      '1. Primary Request and Intent:',
      '   <details>',
    ].join('\n')

    const out = toApiMessages([
      createSystemCompactMessage({ summary, parentUuid: null }),
    ])

    assert.equal(out.length, 1)
    assert.equal(out[0]?.role, 'user')
    assert.equal(out[0]?.content, summary)
    assert.equal(
      typeof out[0]?.content === 'string' && out[0].content.includes('Previous conversation summary:'),
      false,
      'wire-side prefix should not be added to compact boundary summaries',
    )
  })

  it('passes user and assistant messages through unchanged', () => {
    const user = createUserMessage('hi')
    const assistantBlocks = [{ type: 'text' as const, text: 'hello' }]
    const assistantMsg = createAssistantMessage({
      content: assistantBlocks,
      stopReason: 'end_turn',
      usage: {},
    })

    const out = toApiMessages([user, assistantMsg])

    assert.deepEqual(out[0], { role: 'user', content: 'hi' })
    assert.deepEqual(out[1], { role: 'assistant', content: assistantBlocks })
  })
})
