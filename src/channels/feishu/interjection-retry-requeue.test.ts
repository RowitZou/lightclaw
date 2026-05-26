import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  InterjectionQueue,
  type InterjectionEntry,
} from './interjection-queue.js'

// These tests exercise the same pattern channel runner uses to survive a
// transient stream error: interjections drained during a query attempt are
// recorded into a local tracker array, and on retry that array is re-enqueued
// to the head of the per-session FIFO before `rewriteTranscript` wipes the
// tool_result block that held them on disk.
//
// We model the runner's loop with a small `simulateRetryFlow` helper instead
// of standing up the full ChannelRunner — the queue interaction and array
// accumulation are the entire surface the fix relies on, and full streamChat
// mocking would not add coverage that this layer cannot already give.
describe('interjection retry-requeue tracker pattern', () => {
  it('records drained entries and requeues all on retry (single boundary)', () => {
    // Scenario A: user sends I1, I2, I3 while Bash runs; drained at the
    // tool boundary; transient error; retry restores all three.
    const queue = new InterjectionQueue()
    queue.push('s1', entry('m1', 'first'))
    queue.push('s1', entry('m2', 'second'))
    queue.push('s1', entry('m3', 'third'))

    const tracker: InterjectionEntry[] = []
    const drained = drainAndTrack(queue, 's1', tracker)
    assert.equal(drained.length, 3)

    // Transient error → retry path requeues the tracker contents.
    requeueAndReset(queue, 's1', tracker)
    assert.equal(tracker.length, 0)

    // Retry attempt's drain sees the same entries in the original order.
    assert.deepEqual(
      queue.drain('s1').map(e => e.text),
      ['first', 'second', 'third'],
    )
  })

  it('accumulates drains across multiple boundaries before retry (scenario B)', () => {
    // boundary 1: drain [I1]
    // boundary 2: drain [I2]
    // boundary 3: drain [I3, I4]
    // boundary 4: transient → retry, all four bundled at retry's first drain.
    const queue = new InterjectionQueue()
    const tracker: InterjectionEntry[] = []

    queue.push('s1', entry('m1', 'b1-first'))
    drainAndTrack(queue, 's1', tracker)

    queue.push('s1', entry('m2', 'b2-first'))
    drainAndTrack(queue, 's1', tracker)

    queue.push('s1', entry('m3', 'b3-first'))
    queue.push('s1', entry('m4', 'b3-second'))
    drainAndTrack(queue, 's1', tracker)

    assert.equal(tracker.length, 4)

    requeueAndReset(queue, 's1', tracker)

    // Retry's first drain returns all four in original FIFO order.
    assert.deepEqual(
      queue.drain('s1').map(e => e.text),
      ['b1-first', 'b2-first', 'b3-first', 'b3-second'],
    )
  })

  it('newer interjection arrived during retry backoff lands after drained ones (scenario C)', () => {
    const queue = new InterjectionQueue()
    const tracker: InterjectionEntry[] = []

    queue.push('s1', entry('m1', 'drained-1'))
    queue.push('s1', entry('m2', 'drained-2'))
    drainAndTrack(queue, 's1', tracker)

    // Between drain and retry the user sends another interjection. This
    // races with the channel runner's retry sleep; the entry lands in the
    // queue tail while the tracker still holds the drained two.
    queue.push('s1', entry('m3', 'arrived-during-sleep'))

    requeueAndReset(queue, 's1', tracker)

    // Global FIFO: drained first (logically earlier), new one behind.
    assert.deepEqual(
      queue.drain('s1').map(e => e.text),
      ['drained-1', 'drained-2', 'arrived-during-sleep'],
    )
  })

  it('repeated retry does not duplicate (scenario D)', () => {
    // attempt 0 drains I1 → transient → retry requeues + resets tracker
    // attempt 1 drains I1 → transient → retry requeues + resets tracker
    // attempt 2 drains I1 → success → tracker is discarded by scope exit
    const queue = new InterjectionQueue()
    const tracker: InterjectionEntry[] = []
    queue.push('s1', entry('m1', 'only-once'))

    for (let attempt = 0; attempt < 3; attempt += 1) {
      // Retry boundary first: requeue the prior attempt's drained entries.
      if (attempt > 0) {
        requeueAndReset(queue, 's1', tracker)
      }
      const drained = drainAndTrack(queue, 's1', tracker)
      // Every attempt sees exactly one entry — never doubled.
      assert.equal(drained.length, 1)
      assert.equal(drained[0]!.text, 'only-once')
    }

    // After the final successful attempt the tracker still holds I1, but
    // since we exit the retry loop on success we never requeue. The queue
    // is empty.
    assert.equal(queue.size('s1'), 0)
  })

  it('preserves source field on requeue (bg-result interjection)', () => {
    // background-result interjections come from scheduler.deliverCompletion
    // publishing on the signal bus; they also pass through the same drain
    // path and must survive retry rollback with `source` intact so the
    // runner's bg-vs-user branching still classifies them correctly.
    const queue = new InterjectionQueue()
    const tracker: InterjectionEntry[] = []

    queue.push('s1', { ...entry('m-bg', '<background-task-result>...</background-task-result>'), source: 'background-task' })
    queue.push('s1', { ...entry('m-user', 'user follow-up'), source: 'user' })

    drainAndTrack(queue, 's1', tracker)
    requeueAndReset(queue, 's1', tracker)

    const requeued = queue.drain('s1')
    assert.deepEqual(
      requeued.map(e => ({ text: e.text, source: e.source })),
      [
        { text: '<background-task-result>...</background-task-result>', source: 'background-task' },
        { text: 'user follow-up', source: 'user' },
      ],
    )
  })

  it('successful exit (no retry) does not pollute queue', () => {
    // The runner's local `drainedDuringQuery` array is per-handleMessage
    // scope; on a clean end_turn we never call requeueAndReset and the
    // array is simply discarded. Confirm that pattern leaves the queue
    // clean — drained entries are NOT re-added by accident.
    const queue = new InterjectionQueue()
    const tracker: InterjectionEntry[] = []

    queue.push('s1', entry('m1', 'consumed-by-success'))
    drainAndTrack(queue, 's1', tracker)
    assert.equal(tracker.length, 1)

    // Simulate query() returning successfully: scope drops the tracker
    // without calling requeueAndReset. Queue stays empty.
    assert.equal(queue.size('s1'), 0)
  })

  it('requeueAndReset is a no-op when tracker is empty', () => {
    // First retry attempt may run on a turn that had not yet hit any tool
    // boundary, so the tracker is empty. requeueAndReset must be safely
    // callable in that state without touching the queue.
    const queue = new InterjectionQueue()
    queue.push('s1', entry('m1', 'untouched'))
    const tracker: InterjectionEntry[] = []

    requeueAndReset(queue, 's1', tracker)

    assert.deepEqual(queue.drain('s1').map(e => e.text), ['untouched'])
  })
})

// Helpers that mirror the runner's local pattern. They live in the test file
// because the runner inlines this logic — keeping it close to the test keeps
// the intent obvious without exporting a one-line API.

function drainAndTrack(
  queue: InterjectionQueue,
  sessionId: string,
  tracker: InterjectionEntry[],
): InterjectionEntry[] {
  const drained = queue.drain(sessionId)
  if (drained.length > 0) {
    tracker.push(...drained)
  }
  return drained
}

function requeueAndReset(
  queue: InterjectionQueue,
  sessionId: string,
  tracker: InterjectionEntry[],
): number {
  if (tracker.length === 0) return 0
  const count = tracker.length
  queue.requeueHead(sessionId, tracker)
  tracker.length = 0
  return count
}

function entry(messageId: string, text: string): InterjectionEntry {
  return {
    messageId,
    senderOpenId: 'ou_alice',
    text,
    arrivedAt: Date.now(),
  }
}
