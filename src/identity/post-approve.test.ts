import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { SenderKey } from './types.js'
import { synthesizeReplayMessage } from './post-approve.js'

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
