import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  installFakeStrategy,
  makeFakeFeishuMessage,
  runConcurrent,
} from './concurrency-helpers.js'

describe('concurrency helpers', () => {
  it('runConcurrent resolves task results in input order', async () => {
    const result = await runConcurrent([
      async () => {
        await new Promise(resolve => setTimeout(resolve, 20))
        return 'slow'
      },
      async () => 'fast',
    ])

    assert.deepEqual(result, ['slow', 'fast'])
  })

  it('makeFakeFeishuMessage builds a normalized channel message', () => {
    const message = makeFakeFeishuMessage({
      sender: 'ou_alice',
      text: 'hello',
      sessionId: 'alice-session',
    })

    assert.equal(message.channel, 'feishu')
    assert.equal(message.senderOpenId, 'ou_alice')
    assert.equal(message.senderKey, 'feishu:ou_alice')
    assert.equal(message.chatId, 'chat-alice-session')
    assert.equal(message.text, 'hello')
  })

  it('installFakeStrategy captures replies and notices in memory', async () => {
    const strategy = installFakeStrategy('feishu-test')
    const message = makeFakeFeishuMessage({ sender: 'ou_bob', text: 'hi' })

    await strategy.sendReply(message, 'reply')
    await strategy.sendNotice(message, 'info', 'notice', 'plain_text')

    assert.deepEqual(strategy.replies, [{ messageId: message.messageId, text: 'reply' }])
    assert.deepEqual(strategy.notices, [{
      messageId: message.messageId,
      kind: 'info',
      text: 'notice',
      bodyFormat: 'plain_text',
    }])
  })
})
