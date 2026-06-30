import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { SenderKey } from './types.js'
import { shouldSurfaceNoModelOnApproval, synthesizeReplayMessage } from './post-approve.js'

describe('shouldSurfaceNoModelOnApproval', () => {
  it('surfaces the no-model notice for a slash-first message with no model', () => {
    // The runner no-model gate sits after slash dispatch, so a slash replay
    // never reaches it — push the notice here instead.
    assert.equal(shouldSurfaceNoModelOnApproval('/help', ''), true)
    assert.equal(shouldSurfaceNoModelOnApproval('  /status', undefined), true)
  })

  it('skips a non-slash first message (the runner gate covers it on replay → no duplicate)', () => {
    assert.equal(shouldSurfaceNoModelOnApproval('hi there', ''), false)
    assert.equal(shouldSurfaceNoModelOnApproval('', ''), false)
  })

  it('skips when a model IS configured (any first message)', () => {
    assert.equal(shouldSurfaceNoModelOnApproval('/help', 'opus'), false)
    assert.equal(shouldSurfaceNoModelOnApproval('chat', 'opus'), false)
  })
})

describe('synthesizeReplayMessage', () => {
  it('carries threadId + replyAnchorMessageId for topic-group origins', () => {
    // threadId drives the Phase 26 sessionId formula — without it a
    // topic-group replay lands in `feishu:group:<chat>:<sender>` while the
    // user's future in-topic messages route to
    // `feishu:group:<chat>:<thread>:<sender>` (transcript split). The
    // anchor lets the sender reply into the original topic instead of
    // creating a new one per outbound (2026-06-10 dogfood).
    const message = synthesizeReplayMessage({
      openId: 'ou_user',
      senderKey: 'feishu:ou_user' as SenderKey,
      chatId: 'oc_topic_group',
      chatType: 'group',
      text: '帮我分析这篇论文',
      threadId: 'omt_thread_1',
      anchorMessageId: 'om_original_at',
    })

    assert.equal(message.synthetic, true)
    assert.equal(message.chatType, 'group')
    assert.equal(message.threadId, 'omt_thread_1')
    assert.equal(message.replyAnchorMessageId, 'om_original_at')
    assert.match(message.messageId, /^replay-/, 'fabricated id keeps the replay- prefix')
    assert.notEqual(message.replyAnchorMessageId, message.messageId)
  })

  it('omits thread fields for DM / legacy origins', () => {
    const message = synthesizeReplayMessage({
      openId: 'ou_user',
      senderKey: 'feishu:ou_user' as SenderKey,
      chatId: 'oc_dm',
      chatType: 'p2p',
      text: 'hello',
    })

    assert.equal(message.synthetic, true)
    assert.equal('threadId' in message, false)
    assert.equal('replyAnchorMessageId' in message, false)
  })
})
