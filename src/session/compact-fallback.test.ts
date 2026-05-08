import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createAssistantMessage,
  createUserMessage,
  createSystemCompactMessage,
} from '../messages.js'
import type { Message } from '../types.js'
import { compactFallbackTruncate } from './compact-fallback.js'

function userText(text: string): Message {
  return createUserMessage(text)
}

function userToolResult(toolUseId: string, text = 'ok'): Message {
  return createUserMessage([
    { type: 'tool_result', tool_use_id: toolUseId, content: text },
  ])
}

function assistantText(text: string): Message {
  return createAssistantMessage({
    content: [{ type: 'text', text }],
    stopReason: 'end_turn',
    usage: {},
  })
}

function assistantToolUse(id: string, name: string): Message {
  return createAssistantMessage({
    content: [{ type: 'tool_use', id, name, input: {} }],
    stopReason: 'tool_use',
    usage: {},
  })
}

test('returns input unchanged when message count is at or below keep window', () => {
  const messages = [userText('hi'), assistantText('hello')]
  const result = compactFallbackTruncate(messages, {
    keepRecent: 6,
    reason: 'timeout',
  })
  assert.equal(result.removedCount, 0)
  assert.equal(result.messages.length, 2)
})

test('truncates at a fresh user turn and prepends a compact_boundary system message', () => {
  const messages: Message[] = []
  for (let i = 0; i < 8; i++) {
    messages.push(userText(`old query ${i}`))
    messages.push(assistantText(`old reply ${i}`))
  }
  // tail: a fresh user turn at index 14, then assistant at 15
  const result = compactFallbackTruncate(messages, {
    keepRecent: 4,
    reason: 'API 500',
  })

  assert.ok(result.removedCount >= 12, 'should elide most of the prefix')
  assert.equal(result.messages[0]!.type, 'system')
  const summary = (result.messages[0] as { message: { summary: string } }).message.summary
  assert.match(summary, /Compact Fallback/)
  assert.match(summary, /API 500/)
  assert.match(summary, new RegExp(String(result.removedCount)))
  // First non-boundary message must be a fresh user turn (no tool_result blocks).
  const firstKept = result.messages[1]!
  assert.equal(firstKept.type, 'user')
  // Re-parented to the boundary.
  assert.equal(firstKept.parentUuid, result.messages[0]!.uuid)
})

test('walks past a tool_result block to find the next fresh user turn', () => {
  // shape:
  //   [0] user text
  //   [1] assistant tool_use
  //   [2] user tool_result   <- candidate split would land here
  //   [3] assistant text
  //   [4] user text          <- this is the safe split
  //   [5] assistant text
  const messages = [
    userText('q1'),
    assistantToolUse('t1', 'Bash'),
    userToolResult('t1'),
    assistantText('a1'),
    userText('q2'),
    assistantText('a2'),
  ]
  const result = compactFallbackTruncate(messages, {
    keepRecent: 4,
    reason: 'empty summary',
  })
  // Boundary + 2 kept messages (q2, a2)
  assert.equal(result.messages.length, 3)
  assert.equal(result.removedCount, 4)
  const firstKept = result.messages[1]!
  assert.equal(firstKept.type, 'user')
  assert.deepEqual(
    (firstKept as { message: { content: unknown } }).message.content,
    'q2',
  )
})

test('returns input unchanged if no fresh user turn exists in the keep window', () => {
  // Whole tail is a tool loop with no fresh user turn — caller must surface
  // the original prompt-too-long error rather than emit an invalid slice.
  const messages = [
    userText('q1'),
    assistantToolUse('t1', 'Bash'),
    userToolResult('t1'),
    assistantToolUse('t2', 'Bash'),
    userToolResult('t2'),
    assistantToolUse('t3', 'Bash'),
    userToolResult('t3'),
  ]
  const result = compactFallbackTruncate(messages, {
    keepRecent: 4,
    reason: 'timeout',
  })
  assert.equal(result.removedCount, 0)
  assert.equal(result.messages.length, messages.length)
})

test('keepRecent of 0 or 1 floors to 2', () => {
  const messages = [
    userText('q1'),
    assistantText('a1'),
    userText('q2'),
    assistantText('a2'),
    userText('q3'),
  ]
  const result = compactFallbackTruncate(messages, {
    keepRecent: 0,
    reason: 'whatever',
  })
  // floor=2 → candidate split at messages.length - 2 = 3 (assistantText 'a2'),
  // walk forward to userText 'q3' at index 4. Keeps 1 message.
  assert.equal(result.removedCount, 4)
  assert.equal(result.messages.length, 2)
  assert.equal(result.messages[0]!.type, 'system')
})

test('preserves tail order and message identity beyond first kept', () => {
  const messages: Message[] = []
  for (let i = 0; i < 10; i++) {
    messages.push(userText(`q${i}`))
    messages.push(assistantText(`a${i}`))
  }
  const tailUuids = messages.slice(-4).map(m => m.uuid)
  const result = compactFallbackTruncate(messages, {
    keepRecent: 4,
    reason: 'rate limit',
  })
  // tail should be intact past index 1 (boundary + first kept re-parented).
  const keptUuids = result.messages.slice(2).map(m => m.uuid)
  assert.deepEqual(keptUuids, tailUuids.slice(1))
})

test('preserves an existing system compact_boundary in the kept window', () => {
  // If a previous compact already happened, the kept window may start with a
  // system message. The fallback should still emit a fresh boundary in front
  // of it (history of two boundaries is fine; model treats them as sequential
  // summaries) rather than dropping the kept boundary.
  const old = createSystemCompactMessage({
    summary: 'previous summary',
    parentUuid: null,
  })
  const messages: Message[] = [
    userText('q-old'),
    assistantText('a-old'),
    userText('q-old-2'),
    assistantText('a-old-2'),
    old,
    userText('q-new'),
    assistantText('a-new'),
  ]
  const result = compactFallbackTruncate(messages, {
    keepRecent: 3,
    reason: 'oops',
  })
  // candidate split = 7 - 3 = 4 (old system msg). walk forward to q-new at 5.
  assert.equal(result.removedCount, 5)
  assert.equal(result.messages.length, 3)
  assert.match(
    (result.messages[0] as { message: { summary: string } }).message.summary,
    /Compact Fallback/,
  )
})
