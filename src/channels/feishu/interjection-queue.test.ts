import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { InterjectionQueue } from './interjection-queue.js'

describe('InterjectionQueue', () => {
  it('tracks in-flight sessions', () => {
    const queue = new InterjectionQueue()
    assert.equal(queue.hasInflightFor('s1'), false)
    queue.markInFlight('s1')
    assert.equal(queue.hasInflightFor('s1'), true)
    queue.unmarkInFlight('s1')
    assert.equal(queue.hasInflightFor('s1'), false)
  })

  it('drains FIFO entries per session', () => {
    const queue = new InterjectionQueue()
    queue.push('s1', entry('m1', 'first'))
    queue.push('s1', entry('m2', 'second'))
    queue.push('s2', entry('m3', 'other'))

    assert.equal(queue.size('s1'), 2)
    assert.deepEqual(queue.drain('s1').map(item => item.text), ['first', 'second'])
    assert.equal(queue.size('s1'), 0)
    assert.deepEqual(queue.drain('s2').map(item => item.text), ['other'])
  })

  it('unmarkInFlight returns and clears leftover entries', () => {
    // Bug 9 in 2026-05-10 audit: prior shape silently dropped the queue
    // here, losing post-query interjections. Now leftovers come back so
    // the runner can replay them as fresh turns.
    const queue = new InterjectionQueue()
    queue.markInFlight('s1')
    queue.push('s1', entry('m1', 'stale'))

    const leftover = queue.unmarkInFlight('s1')

    assert.equal(queue.hasInflightFor('s1'), false)
    assert.deepEqual(leftover.map(e => e.text), ['stale'])
    // Subsequent drain still returns empty — leftovers are consumed by the
    // unmarkInFlight return value, not left in the queue for double-drain.
    assert.deepEqual(queue.drain('s1'), [])
  })

  it('unmarkInFlight returns empty array when no entries pending', () => {
    const queue = new InterjectionQueue()
    queue.markInFlight('s1')
    const leftover = queue.unmarkInFlight('s1')
    assert.equal(queue.hasInflightFor('s1'), false)
    assert.deepEqual(leftover, [])
  })

  it('maps an opener messageId back to its sessionId and clears it on unmark', () => {
    // The recall handler relies on this map: Feishu's recall event only
    // ships message_id + chat_id, so messageId -> sessionId is the only
    // way to find the in-flight turn to abort.
    const queue = new InterjectionQueue()
    queue.markInFlight('s1', 'om_opener_1')
    queue.markInFlight('s2', 'om_opener_2')
    assert.equal(queue.sessionIdForOpenerMessage('om_opener_1'), 's1')
    assert.equal(queue.sessionIdForOpenerMessage('om_opener_2'), 's2')
    assert.equal(queue.sessionIdForOpenerMessage('om_unknown'), undefined)

    queue.unmarkInFlight('s1')
    assert.equal(queue.sessionIdForOpenerMessage('om_opener_1'), undefined)
    assert.equal(queue.sessionIdForOpenerMessage('om_opener_2'), 's2')
  })

  it('markInFlight without an opener messageId stays backward-compatible', () => {
    const queue = new InterjectionQueue()
    queue.markInFlight('s1')
    assert.equal(queue.hasInflightFor('s1'), true)
    assert.equal(queue.sessionIdForOpenerMessage('anything'), undefined)
  })

  it('removeQueuedByMessageId removes a not-yet-drained interjection by id', () => {
    const queue = new InterjectionQueue()
    queue.push('s1', entry('m1', 'first'))
    queue.push('s1', entry('m2', 'second'))
    queue.push('s2', entry('m3', 'other'))

    assert.equal(queue.removeQueuedByMessageId('m2'), 's1')
    assert.deepEqual(queue.drain('s1').map(e => e.text), ['first'])
    assert.equal(queue.removeQueuedByMessageId('m3'), 's2')
    assert.equal(queue.size('s2'), 0)
    // Unknown / already-removed id returns undefined — the recall handler
    // treats that as "already drained or never queued", a no-op.
    assert.equal(queue.removeQueuedByMessageId('m2'), undefined)
    assert.equal(queue.removeQueuedByMessageId('never'), undefined)
  })

  // requeueHead is the retry-rollback path: interjections drained during a
  // query attempt whose transcript got rewritten back to the pre-query
  // baseline need to be put back at the head of the queue so the retry's
  // next drain sees them again. Without it the user's mid-turn words are
  // lost to a transient stream error (2026-05-26 dogfood DM session: codex
  // SSE truncated a Dispatch arguments JSON, both attempt retries failed,
  // rewriteTranscript wiped the tool_result block that held the "clone 3
  // projects" interjection, and the queue had already drained it).
  it('requeueHead empty array is a no-op', () => {
    const queue = new InterjectionQueue()
    queue.push('s1', entry('m1', 'existing'))
    queue.requeueHead('s1', [])
    assert.deepEqual(queue.drain('s1').map(e => e.text), ['existing'])
  })

  it('requeueHead prepends entries preserving their internal order', () => {
    const queue = new InterjectionQueue()
    queue.requeueHead('s1', [entry('m1', 'a'), entry('m2', 'b')])
    assert.deepEqual(queue.drain('s1').map(e => e.text), ['a', 'b'])
  })

  it('requeueHead with newer queued entries: drained come first, newer stay behind', () => {
    // Scenario C from the design doc: user sends I1, I2; drain happens at
    // a tool boundary; transient error; during retry backoff user sends I3;
    // requeueHead restores I1/I2 at the head — global FIFO must hold.
    const queue = new InterjectionQueue()
    queue.push('s1', entry('m3', 'new-after-drain'))
    queue.requeueHead('s1', [entry('m1', 'drained-1'), entry('m2', 'drained-2')])
    assert.deepEqual(
      queue.drain('s1').map(e => e.text),
      ['drained-1', 'drained-2', 'new-after-drain'],
    )
  })

  it('remembers drained genuine-user interjections for recall lookup', () => {
    // The recall handler uses this to surface a withdrawal note for an
    // interjection that was already injected (and so cannot be un-injected).
    const queue = new InterjectionQueue()
    queue.markInFlight('s1')
    queue.push('s1', entry('m1', 'follow up please'))
    queue.drain('s1')
    const hit = queue.drainedInterjectionByMessageId('m1')
    assert.deepEqual(hit, { sessionId: 's1', text: 'follow up please' })
    assert.equal(queue.drainedInterjectionByMessageId('never'), undefined)
  })

  it('does not remember synthetic / background-task drained entries', () => {
    // Synthetic ids never match a platform recall event, and carry framework
    // text, not user words — recording them would be noise.
    const queue = new InterjectionQueue()
    queue.markInFlight('s1')
    queue.push('s1', { ...entry('bg1', 'bg result'), synthetic: true })
    queue.push('s1', { ...entry('m2', 'wake'), source: 'background-task' as const })
    queue.drain('s1')
    assert.equal(queue.drainedInterjectionByMessageId('bg1'), undefined)
    assert.equal(queue.drainedInterjectionByMessageId('m2'), undefined)
  })

  it('clears remembered drained interjections on unmarkInFlight', () => {
    const queue = new InterjectionQueue()
    queue.markInFlight('s1')
    queue.push('s1', entry('m1', 'hi'))
    queue.drain('s1')
    assert.ok(queue.drainedInterjectionByMessageId('m1'))
    queue.unmarkInFlight('s1')
    assert.equal(queue.drainedInterjectionByMessageId('m1'), undefined)
  })
})

function entry(messageId: string, text: string) {
  return {
    messageId,
    senderOpenId: 'ou_alice',
    text,
    arrivedAt: Date.now(),
  }
}
