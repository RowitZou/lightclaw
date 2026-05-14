import test from 'node:test'
import assert from 'node:assert/strict'

import { buildMemoryNudgeBlock, isMemoryNudgeDue } from './nudge.js'

test('isMemoryNudgeDue fires once everyTurns turns have passed', () => {
  // First nudge: lastNudgeTurn = 0, everyTurns = 20.
  assert.equal(isMemoryNudgeDue(19, 0, 20), false)
  assert.equal(isMemoryNudgeDue(20, 0, 20), true)
  assert.equal(isMemoryNudgeDue(25, 0, 20), true)
})

test('isMemoryNudgeDue measures from the last nudge, not from turn 0', () => {
  // After a nudge at turn 20, the next one is due at turn 40.
  assert.equal(isMemoryNudgeDue(39, 20, 20), false)
  assert.equal(isMemoryNudgeDue(40, 20, 20), true)
})

test('isMemoryNudgeDue carries a missed nudge to the next boundary', () => {
  // A nudge that came due at turn 20 but never got injected (turn ended on
  // end_turn, no tool boundary) is still due at turn 23 — lastNudgeTurn is
  // only advanced when the block is actually injected.
  assert.equal(isMemoryNudgeDue(23, 0, 20), true)
})

test('isMemoryNudgeDue never fires at turn 0 or with a non-positive interval', () => {
  assert.equal(isMemoryNudgeDue(0, 0, 20), false)
  assert.equal(isMemoryNudgeDue(20, 0, 0), false)
  assert.equal(isMemoryNudgeDue(20, 0, -5), false)
})

test('buildMemoryNudgeBlock is a self-contained passive reminder block', () => {
  const block = buildMemoryNudgeBlock()
  assert.ok(block.startsWith('<memory-nudge>'))
  assert.ok(block.endsWith('</memory-nudge>'))
  // Passive framing — must not read as a user task.
  assert.match(block, /Passive reminder/)
  assert.match(block, /Do not mention it to the user/)
  // Points at the existing MemoryWrite path via ToolSearch (it is deferred).
  assert.match(block, /ToolSearch\(\{query: "select:MemoryWrite"\}\)/)
  assert.match(block, /MemoryWrite/)
  // The whole reason this path exists: capture the "why".
  assert.match(block, /why/i)
  // Anti-noise guardrail.
  assert.match(block, /Do not save trivia/)
})
