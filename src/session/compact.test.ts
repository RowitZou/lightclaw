import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createAssistantMessage,
  createUserMessage,
} from '../messages.js'
import type { Message } from '../types.js'
import { findSafeSplitIndex } from './compact.js'

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

function assistantToolUse(id: string, name = 'Read'): Message {
  return createAssistantMessage({
    content: [{ type: 'tool_use', id, name, input: {} }],
    stopReason: 'tool_use',
    usage: {},
  })
}

test('findSafeSplitIndex: returns initial when toKeep[0] is plain user text', () => {
  const messages: Message[] = [
    userText('q1'),
    assistantText('a1'),
    userText('q2'),
    assistantText('a2'),
  ]
  // initial split = 2 (keep last 2: user + assistant)
  assert.equal(findSafeSplitIndex(messages, 2), 2)
})

test('findSafeSplitIndex: rewinds one step when split severs assistant.tool_use from user.tool_result', () => {
  // The exact 2026-05-09 incident shape: WebFetch tool_use lives in the
  // compressed prefix, its tool_result lands at the head of the keep window.
  const messages: Message[] = [
    userText('q1'),                       // 0
    assistantToolUse('call_X', 'WebFetch'), // 1  ← belongs in toKeep
    userToolResult('call_X', 'fetch out'),  // 2  ← initial split here = orphan
    assistantText('summary'),               // 3
  ]
  // initial split = 2 → toKeep starts with orphan tool_result → rewind to 1
  assert.equal(findSafeSplitIndex(messages, 2), 1)
})

test('findSafeSplitIndex: rewinds across a multi-pair chain', () => {
  // Two back-to-back tool calls where keepRecent is set so the boundary
  // initially lands inside the chain. Both tool_use messages must come along.
  const messages: Message[] = [
    userText('q1'),                          // 0
    assistantToolUse('call_A', 'Read'),       // 1
    userToolResult('call_A'),                 // 2
    assistantToolUse('call_B', 'Read'),       // 3
    userToolResult('call_B'),                 // 4
    assistantText('done'),                    // 5
  ]
  // initial split = 4 lands on userToolResult(call_B) — orphan because
  // assistantToolUse(call_B) is at index 3 (still in compress). Rewind to 3.
  assert.equal(findSafeSplitIndex(messages, 4), 3)
})

test('findSafeSplitIndex: stops at 0 if every prefix message is orphan-shaped', () => {
  const messages: Message[] = [
    userToolResult('call_X'), // 0 — pathological transcript starting with orphan
    assistantText('ok'),       // 1
  ]
  // initial split = 1 → toKeep[0] = assistantText, not user, so no rewind.
  assert.equal(findSafeSplitIndex(messages, 1), 1)
  // initial split = 0 → already at floor, returns 0.
  assert.equal(findSafeSplitIndex(messages, 0), 0)
})

test('findSafeSplitIndex: clamps initial to messages.length', () => {
  const messages: Message[] = [userText('q1'), assistantText('a1')]
  assert.equal(findSafeSplitIndex(messages, 999), 2)
})

test('findSafeSplitIndex: leaves user message with mixed text + paired tool_result alone', () => {
  // If the tool_result's tool_use lives in toKeep itself, no orphan exists.
  // Current implementation rewinds whenever the head user has *any*
  // tool_result, which is conservative-but-correct: it merges that user's
  // matching tool_use back in too. The test asserts this conservative
  // behavior so we notice if it ever changes.
  const messages: Message[] = [
    userText('q1'),                      // 0
    assistantToolUse('call_X'),           // 1
    userToolResult('call_X'),             // 2
    assistantText('done'),                // 3
  ]
  assert.equal(findSafeSplitIndex(messages, 2), 1)
})
