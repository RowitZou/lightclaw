import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { PendingSlashQueue } from './pending-slash-queue.js'
import type { NormalizedChannelMessage } from '../types.js'

describe('PendingSlashQueue', () => {
  it('drains FIFO entries per session', () => {
    const queue = new PendingSlashQueue()
    queue.push('s1', slash('m1', '/mode auto'))
    queue.push('s1', slash('m2', '/model claude-opus-4-7'))
    queue.push('s2', slash('m3', '/rules allow Edit(/tmp/**)'))

    assert.equal(queue.size('s1'), 2)
    assert.deepEqual(
      queue.drain('s1').map(m => m.text),
      ['/mode auto', '/model claude-opus-4-7'],
    )
    assert.equal(queue.size('s1'), 0)
    assert.deepEqual(queue.drain('s2').map(m => m.text), ['/rules allow Edit(/tmp/**)'])
  })

  it('drain clears the session so a second drain returns empty', () => {
    const queue = new PendingSlashQueue()
    queue.push('s1', slash('m1', '/mode read'))
    assert.equal(queue.drain('s1').length, 1)
    assert.deepEqual(queue.drain('s1'), [])
  })

  it('keeps sessions isolated', () => {
    const queue = new PendingSlashQueue()
    queue.push('s1', slash('m1', '/mode auto'))
    assert.equal(queue.size('s2'), 0)
    assert.deepEqual(queue.drain('s2'), [])
    assert.equal(queue.size('s1'), 1)
  })
})

function slash(messageId: string, text: string): NormalizedChannelMessage {
  return {
    channel: 'feishu',
    eventId: `evt-${messageId}`,
    chatId: 'oc_chat',
    chatType: 'p2p',
    senderOpenId: 'ou_alice',
    messageId,
    text,
  }
}
