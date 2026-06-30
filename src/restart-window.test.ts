import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  RESTART_FLOOR_MAX_LOOKBACK_MS,
  computeStaleEventCutoff,
} from './restart-window.js'

const BUFFER = 5_000

test('no floor → cutoff is the plain buffer below transport start', () => {
  const startedAt = 1_000_000
  assert.equal(computeStaleEventCutoff(startedAt, BUFFER, undefined), startedAt - BUFFER)
})

test('a recent restart floor lowers the cutoff to honor the down window', () => {
  // Daemon init took 30s, so transport-up is 30s after the restart was initiated.
  const restartInitiatedAt = 1_000_000
  const startedAt = restartInitiatedAt + 30_000
  const cutoff = computeStaleEventCutoff(startedAt, BUFFER, restartInitiatedAt)
  // Honored back to the restart-initiation time minus the skew buffer.
  assert.equal(cutoff, restartInitiatedAt - BUFFER)
})

test('REGRESSION: a message sent during the down window is kept with the floor, dropped without it', () => {
  // init (20s) exceeds the 5s buffer — the exact condition that loses messages.
  const restartInitiatedAt = 2_000_000
  const startedAt = restartInitiatedAt + 20_000
  // User sends 2s into the down window — well before transport-up.
  const downWindowMsgCreatedAt = restartInitiatedAt + 2_000

  const withFloor = computeStaleEventCutoff(startedAt, BUFFER, restartInitiatedAt)
  const withoutFloor = computeStaleEventCutoff(startedAt, BUFFER, undefined)

  // With the floor the message is at-or-above the cutoff → kept.
  assert.ok(downWindowMsgCreatedAt >= withFloor, 'down-window message must be kept with the floor')
  // Without the floor (pre-fix behavior) the same message is below the cutoff → dropped.
  assert.ok(downWindowMsgCreatedAt < withoutFloor, 'pre-fix cutoff would have dropped it')
})

test('an implausibly old floor is ignored (a stale sentinel cannot resurrect a backlog)', () => {
  const startedAt = 5_000_000
  const ancientFloor = startedAt - RESTART_FLOOR_MAX_LOOKBACK_MS - 1
  assert.equal(computeStaleEventCutoff(startedAt, BUFFER, ancientFloor), startedAt - BUFFER)
})

test('a floor only ever widens the window — cutoff is never above the default buffer', () => {
  // Safety invariant: applying a floor must never NARROW the honored window
  // (raise the cutoff), only widen it. Whatever the floor, cutoff <= base.
  const startedAt = 1_000_000
  const base = startedAt - BUFFER
  for (const floor of [startedAt - 1_000, startedAt - 30_000, startedAt, startedAt + 50_000]) {
    assert.ok(
      computeStaleEventCutoff(startedAt, BUFFER, floor) <= base,
      `floor=${floor} must not raise the cutoff above base`,
    )
  }
})
