import test from 'node:test'
import assert from 'node:assert/strict'

import type { FeishuChannelConfig, NormalizedChannelMessage } from '../types.js'
import type { FeishuClient } from './client.js'
import { FeishuSender } from './sender.js'

const baseConfig: FeishuChannelConfig = {
  enabled: true,
  domain: 'feishu',
  transport: 'ws',
  permissionMode: 'default',
  allowUsers: ['*'],
  allowChats: ['*'],
  textChunkSize: 4000,
  httpTimeoutMs: 30_000,
  maxBodyBytes: 1024 * 1024,
  mediaEnabled: true,
  mediaDir: '/tmp/lightclaw-feishu-test',
  typingReaction: false,
  webhook: {
    host: '0.0.0.0',
    port: 18_850,
    path: '/feishu/events',
  },
}

const baseMessage: NormalizedChannelMessage = {
  channel: 'feishu',
  eventId: 'evt_1',
  chatId: 'oc_chat',
  senderOpenId: 'ou_sender',
  messageId: 'om_source',
  text: 'hello',
}

test('FeishuSender falls back to create message after transient reply failure', async () => {
  let replyCalls = 0
  let createCalls = 0
  const transient = new Error('Client network socket disconnected before secure TLS connection was established') as Error & {
    code: string
  }
  transient.code = 'ECONNRESET'
  const client = {
    im: {
      message: {
        reply: async () => {
          replyCalls += 1
          throw transient
        },
        create: async (input: unknown) => {
          createCalls += 1
          assert.deepEqual((input as { params: unknown }).params, { receive_id_type: 'chat_id' })
          return { code: 0, data: { message_id: 'om_created' } }
        },
      },
      file: {
        create: async () => null,
      },
    },
  } as unknown as FeishuClient

  const sender = new FeishuSender(client, baseConfig, { baseDelayMs: 1 })
  await sender.sendInteractiveCard(baseMessage, { elements: [] })

  // Production retries 7 times before falling back to create (cd7282e widened
  // the budget to ~30s of corp-proxy-reset coverage; see sender.ts comment).
  assert.equal(replyCalls, 7)
  assert.equal(createCalls, 1)
})

test('FeishuSender does not fall back to create message for non-transient reply errors', async () => {
  let createCalls = 0
  const client = {
    im: {
      message: {
        reply: async () => {
          throw new Error('Feishu reply failed: 99991663 invalid app credential')
        },
        create: async () => {
          createCalls += 1
          return { code: 0 }
        },
      },
      file: {
        create: async () => null,
      },
    },
  } as unknown as FeishuClient

  const sender = new FeishuSender(client, baseConfig)
  await assert.rejects(
    () => sender.sendInteractiveCard(baseMessage, { elements: [] }),
    /invalid app credential/,
  )

  assert.equal(createCalls, 0)
})
