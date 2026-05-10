import test from 'node:test'
import assert from 'node:assert/strict'

import { dropOrphanToolResults } from './orphan-tool-result.js'
import type { ApiMessage } from './types.js'

test('passes through messages with no tool_result blocks', () => {
  const messages: ApiMessage[] = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
  ]
  const out = dropOrphanToolResults(messages)
  assert.equal(out.length, 2)
  assert.equal(out[0], messages[0])
  assert.equal(out[1], messages[1])
})

test('keeps tool_result blocks whose tool_use_id was emitted by an earlier assistant', () => {
  const messages: ApiMessage[] = [
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'call_1', name: 'Read', input: {} },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_1', content: 'ok' },
      ],
    },
  ]
  const out = dropOrphanToolResults(messages)
  assert.equal(out.length, 2)
  const userOut = out[1] as ApiMessage & { content: unknown[] }
  assert.equal((userOut.content as unknown[]).length, 1)
})

test('drops orphan tool_result block but keeps surrounding text', () => {
  const messages: ApiMessage[] = [
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_GHOST', content: 'leftover' },
        { type: 'text', text: 'follow-up question' },
      ],
    },
  ]
  const out = dropOrphanToolResults(messages)
  assert.equal(out.length, 1)
  const userOut = out[0] as ApiMessage & { content: Array<{ type: string }> }
  assert.equal(userOut.content.length, 1)
  assert.equal(userOut.content[0].type, 'text')
})

test('drops a user message whose only block is an orphan tool_result', () => {
  // Reproduces the 2026-05-09 OpenAI Responses incident shape: compact
  // emitted a user-summary message followed by an orphan WebFetch tool_result.
  const messages: ApiMessage[] = [
    { role: 'user', content: 'Previous conversation summary: ...' },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_JW0XwwzySGR3tSZPtG2gqjdw', content: 'gematsu html' },
      ],
    },
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'call_iKrcjyIh3X927ib7Mu5jZu1j', name: 'WebSearch', input: {} },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_iKrcjyIh3X927ib7Mu5jZu1j', content: 'search results' },
      ],
    },
  ]
  const out = dropOrphanToolResults(messages)
  assert.equal(out.length, 3, 'orphan-only user message removed')
  assert.equal(out[0], messages[0])
  assert.equal(out[1], messages[2])
  // Tail still has its valid tool_result.
  const tail = out[2] as ApiMessage & { content: Array<{ type: string }> }
  assert.equal(tail.content.length, 1)
  assert.equal(tail.content[0].type, 'tool_result')
})

test('does not mutate the original message list', () => {
  const original: ApiMessage[] = [
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_GHOST', content: 'x' },
        { type: 'text', text: 'kept' },
      ],
    },
  ]
  const before = JSON.stringify(original)
  dropOrphanToolResults(original)
  assert.equal(JSON.stringify(original), before)
})

test('respects ordering: a tool_use that comes after the tool_result does NOT save it', () => {
  // The relationship is causal: tool_use must precede its tool_result.
  // A misordered transcript is still an orphan from the API's point of view.
  const messages: ApiMessage[] = [
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_FUTURE', content: 'x' },
      ],
    },
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'call_FUTURE', name: 'Read', input: {} },
      ],
    },
  ]
  const out = dropOrphanToolResults(messages)
  // First message removed (orphan), second kept.
  assert.equal(out.length, 1)
  assert.equal((out[0] as ApiMessage).role, 'assistant')
})
