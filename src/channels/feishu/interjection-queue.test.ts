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

  it('unmarkInFlight clears stale queued entries', () => {
    const queue = new InterjectionQueue()
    queue.markInFlight('s1')
    queue.push('s1', entry('m1', 'stale'))

    queue.unmarkInFlight('s1')

    assert.equal(queue.hasInflightFor('s1'), false)
    assert.deepEqual(queue.drain('s1'), [])
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
