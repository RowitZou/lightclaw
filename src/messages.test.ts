import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  createAssistantMessage,
  createSystemCompactMessage,
  createUserMessage,
  injectSystemReminderIntoLastUserMessage,
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

describe('injectSystemReminderIntoLastUserMessage', () => {
  const reminder = '<system-reminder>todo updated</system-reminder>'

  it('returns input unchanged when reminder is empty', () => {
    const messages = [{ role: 'user' as const, content: 'hi' }]
    const out = injectSystemReminderIntoLastUserMessage(messages, '')
    assert.strictEqual(out, messages)
  })

  it('wraps a string-content last user message into a [text, reminder] block array', () => {
    const messages = [
      { role: 'user' as const, content: 'first' },
      { role: 'assistant' as const, content: [{ type: 'text', text: 'ack' }] },
      { role: 'user' as const, content: 'second' },
    ]
    const out = injectSystemReminderIntoLastUserMessage(messages, reminder)
    assert.deepEqual(out[2], {
      role: 'user',
      content: [
        { type: 'text', text: 'second' },
        { type: 'text', text: reminder },
      ],
    })
    // Earlier messages are passed through by reference (no clone, no mutation).
    assert.strictEqual(out[0], messages[0])
    assert.strictEqual(out[1], messages[1])
  })

  it('appends the reminder block to an array-content last user message', () => {
    const lastContent = [
      { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
      { type: 'text', text: 'follow-up' },
    ]
    const messages = [
      { role: 'user' as const, content: 'first' },
      { role: 'user' as const, content: lastContent },
    ]
    const out = injectSystemReminderIntoLastUserMessage(messages, reminder)
    assert.deepEqual(out[1], {
      role: 'user',
      content: [...lastContent, { type: 'text', text: reminder }],
    })
    // Original array not mutated (caller may still hold a reference).
    assert.strictEqual(lastContent.length, 2)
  })

  it('targets the LAST user message, not the first', () => {
    const messages = [
      { role: 'user' as const, content: 'first' },
      { role: 'assistant' as const, content: [] },
      { role: 'user' as const, content: 'second' },
      { role: 'assistant' as const, content: [] },
      { role: 'user' as const, content: 'third' },
    ]
    const out = injectSystemReminderIntoLastUserMessage(messages, reminder)
    // First two user messages untouched.
    assert.strictEqual(out[0]?.content, 'first')
    assert.strictEqual(out[2]?.content, 'second')
    // Third (last) gets the injection.
    assert.deepEqual(out[4], {
      role: 'user',
      content: [
        { type: 'text', text: 'third' },
        { type: 'text', text: reminder },
      ],
    })
  })

  it('returns input unchanged when there is no user message', () => {
    const messages = [
      { role: 'assistant' as const, content: [{ type: 'text', text: 'no user yet' }] },
    ]
    const out = injectSystemReminderIntoLastUserMessage(messages, reminder)
    assert.strictEqual(out, messages)
  })

  // Regression guard against the 2026-05-26 dogfood pattern: the per-turn
  // volatile suffix used to be concatenated onto `instructions` (OpenAI) /
  // added as a second uncached system block (Anthropic), which broke auto
  // prefix-cache for the entire `messages` tail on OpenAI Codex. The fix
  // moves the suffix into the last user message. This test pins the
  // contract: stable system text stays untouched by helper, suffix lives
  // in the last user message content.
  it('mirrors the query.ts wiring contract: system stays stable, suffix lands in last user content', () => {
    const stableSystem = 'persona + memory + tool catalog'
    const variableSuffix = '## Current Todo List\n- [x] done\n- [ ] todo'
    const inputMessages = toApiMessages([
      createUserMessage('first turn prompt'),
      createAssistantMessage({ content: [{ type: 'text', text: 'ack' }], stopReason: 'end_turn', usage: {} }),
      createUserMessage([
        { type: 'tool_result', tool_use_id: 't1', content: 'ok' } as unknown as Parameters<typeof createUserMessage>[0] extends infer T ? T : never,
      ] as unknown as string),
    ])
    const wire = injectSystemReminderIntoLastUserMessage(inputMessages, variableSuffix)
    assert.equal(
      stableSystem.includes(variableSuffix),
      false,
      'stable system text must not contain the variable suffix; if it does, the suffix was concat-ed somewhere it should not be',
    )
    const last = wire[wire.length - 1]
    assert.equal(last?.role, 'user')
    assert.ok(Array.isArray(last?.content), 'last user content should be a block array post-inject')
    const blocks = last?.content as Array<{ type: string; text?: string }>
    assert.ok(
      blocks.some(b => b.type === 'text' && b.text === variableSuffix),
      'variable suffix text block must be present in last user message content',
    )
  })
})
