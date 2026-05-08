import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { FeishuChannelConfig, NormalizedChannelMessage } from '../types.js'
import {
  isMentionGateSatisfied,
  resolveFeishuSessionId,
} from './routing.js'

const config: FeishuChannelConfig = {
  enabled: true,
  domain: 'feishu',
  transport: 'ws',
  permissionMode: 'default',
  allowUsers: ['*'],
  allowChats: ['*'],
  requireMention: true,
  textChunkSize: 4000,
  httpTimeoutMs: 30_000,
  maxBodyBytes: 1024 * 1024,
  mediaEnabled: true,
  typingReaction: true,
  webhook: { host: '0.0.0.0', port: 18_850, path: '/feishu/events' },
}

function msg(overrides: Partial<NormalizedChannelMessage> = {}): NormalizedChannelMessage {
  return {
    channel: 'feishu',
    eventId: 'evt',
    chatId: 'oc_chat',
    senderOpenId: 'ou_sender',
    chatType: 'group',
    messageId: 'om_msg',
    text: 'hello',
    ...overrides,
  }
}

describe('resolveFeishuSessionId', () => {
  it('routes DM messages by chat id', () => {
    assert.equal(
      resolveFeishuSessionId(msg({ chatType: 'p2p', chatId: 'oc_dm' }), config, 'alice'),
      'feishu:dm:oc_dm',
    )
    assert.equal(
      resolveFeishuSessionId(msg({ chatType: 'private', chatId: 'oc_private' }), config, 'alice'),
      'feishu:dm:oc_private',
    )
  })

  it('routes group messages by chat id and sender open id', () => {
    assert.equal(
      resolveFeishuSessionId(msg({ chatType: 'group' }), config, 'alice'),
      'feishu:group:oc_chat:ou_sender',
    )
  })

  it('routes topic/thread group messages by chat id, thread id, and sender open id', () => {
    assert.equal(
      resolveFeishuSessionId(msg({ chatType: 'topic_group', threadId: 'thr_1' }), config, 'alice'),
      'feishu:group:oc_chat:thr_1:ou_sender',
    )
    assert.equal(
      resolveFeishuSessionId(msg({ chatType: 'thread_group', threadId: 'thr_2' }), config, 'alice'),
      'feishu:group:oc_chat:thr_2:ou_sender',
    )
  })

  it('treats unknown chat types as group-like and sanitizes parts', () => {
    assert.equal(
      resolveFeishuSessionId(
        msg({
          chatType: 'surprise',
          chatId: 'oc.chat:1',
          threadId: 'thr.2',
          senderOpenId: 'ou:sender',
        }),
        config,
        'alice',
      ),
      'feishu:group:oc_chat_1:thr_2:ou_sender',
    )
  })
})

describe('isMentionGateSatisfied', () => {
  it('always allows DM messages', () => {
    assert.deepEqual(
      isMentionGateSatisfied({
        message: msg({ chatType: 'p2p', feishuMentions: [] }),
        config,
        botOpenId: 'ou_bot',
        botName: 'LightClaw',
      }),
      { ok: true },
    )
  })

  it('allows group messages when requireMention is disabled', () => {
    assert.deepEqual(
      isMentionGateSatisfied({
        message: msg({ feishuMentions: [] }),
        config: { ...config, requireMention: false },
        botOpenId: 'ou_bot',
        botName: 'LightClaw',
      }),
      { ok: true },
    )
  })

  it('allows structured mentions of the bot open id', () => {
    assert.deepEqual(
      isMentionGateSatisfied({
        message: msg({ feishuMentions: [{ openId: 'ou_bot', name: 'LightClaw' }] }),
        config,
        botOpenId: 'ou_bot',
        botName: 'LightClaw',
      }),
      { ok: true },
    )
  })

  it('allows raw @botName fallback text', () => {
    assert.deepEqual(
      isMentionGateSatisfied({
        message: msg({ text: '@LightClaw help', feishuMentions: [] }),
        config,
        botOpenId: 'ou_bot',
        botName: 'LightClaw',
      }),
      { ok: true },
    )
  })

  it('drops non-mentioned group messages', () => {
    assert.deepEqual(
      isMentionGateSatisfied({
        message: msg({ text: 'ambient chatter', feishuMentions: [] }),
        config,
        botOpenId: 'ou_bot',
        botName: 'LightClaw',
      }),
      { ok: false, reason: 'no-mention' },
    )
  })

  it('passes through when bot identity is unknown', () => {
    assert.deepEqual(
      isMentionGateSatisfied({
        message: msg({ text: 'ambient chatter', feishuMentions: [] }),
        config,
      }),
      { ok: true, reason: 'unknown-bot-identity' },
    )
  })
})
