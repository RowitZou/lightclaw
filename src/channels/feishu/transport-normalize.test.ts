import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { normalizeReceiveV1 } from './transport-ws.js'
import { normalizeEvent } from './transport-webhook.js'

const BOT_ID = 'ou_bot'

// "Pure @bot" group inputs strip down to '' inside parseMessageContent
// (botStripId replaces every bot-mention key with ''). Before the fix at
// transport-ws.ts and transport-webhook.ts, the empty post-strip text caused
// both transports to return null — the runner never saw the event, the
// pairing flow could not start, and the only signal was the stderr line
// "dropped empty or unsupported receive_v1 event". The mention-aware escape
// keeps the event flowing so the mention gate / pairing / runner-side greet
// short-circuit can take over.

describe('normalizeReceiveV1 strip-empty escape', () => {
  it('keeps a pure @bot group message instead of dropping it as empty', () => {
    const result = normalizeReceiveV1({
      event_id: 'evt-1',
      sender: { sender_id: { open_id: 'ou_alice' } },
      message: {
        message_id: 'msg-1',
        chat_id: 'oc_test',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '@_user_1' }),
        mentions: [
          { key: '@_user_1', name: 'LightClaw', id: { open_id: BOT_ID } },
        ],
      },
    }, BOT_ID)

    assert.ok(result, 'pure @bot inbound must not be dropped')
    assert.equal(result.text, '')
    assert.equal(result.senderOpenId, 'ou_alice')
    assert.equal(result.chatId, 'oc_test')
    assert.equal(result.chatType, 'group')
    assert.deepEqual(result.mentions, [
      { key: '@_user_1', name: 'LightClaw', openId: BOT_ID },
    ])
  })

  it('still drops messages with no text, no media, and no bot mention', () => {
    const result = normalizeReceiveV1({
      event_id: 'evt-2',
      sender: { sender_id: { open_id: 'ou_alice' } },
      message: {
        message_id: 'msg-2',
        chat_id: 'oc_test',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '' }),
      },
    }, BOT_ID)

    assert.equal(result, null)
  })

  it('keeps a @bot inbound with extra text untouched (regression guard)', () => {
    const result = normalizeReceiveV1({
      event_id: 'evt-3',
      sender: { sender_id: { open_id: 'ou_alice' } },
      message: {
        message_id: 'msg-3',
        chat_id: 'oc_test',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '@_user_1 hello' }),
        parent_id: 'om_parent',
        mentions: [
          { key: '@_user_1', name: 'LightClaw', id: { open_id: BOT_ID } },
        ],
      },
    }, BOT_ID)

    assert.ok(result)
    assert.equal(result.text, 'hello')
    assert.equal(result.parentId, 'om_parent')
  })

  it('escape does not fire when bot open_id is unknown', () => {
    // botOpenId === undefined means the startup probe failed; in that case
    // strip is a no-op so an empty body genuinely is empty and should drop.
    const result = normalizeReceiveV1({
      event_id: 'evt-4',
      sender: { sender_id: { open_id: 'ou_alice' } },
      message: {
        message_id: 'msg-4',
        chat_id: 'oc_test',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '' }),
        mentions: [
          { key: '@_user_1', name: 'LightClaw', id: { open_id: BOT_ID } },
        ],
      },
    })

    assert.equal(result, null)
  })
})

describe('normalizeEvent (webhook) strip-empty escape', () => {
  function buildBody(overrides: { text: string; mentions?: unknown[] }): Record<string, unknown> {
    return {
      header: {
        event_id: 'evt-w-1',
        event_type: 'im.message.receive_v1',
      },
      event: {
        sender: { sender_id: { open_id: 'ou_alice' } },
        message: {
          message_id: 'msg-w-1',
          chat_id: 'oc_test',
          chat_type: 'group',
          message_type: 'text',
          content: JSON.stringify({ text: overrides.text }),
          parent_id: 'om_webhook_parent',
          mentions: overrides.mentions ?? [],
        },
      },
    }
  }

  it('keeps a pure @bot group message instead of dropping it as empty', () => {
    const result = normalizeEvent(buildBody({
      text: '@_user_1',
      mentions: [
        { key: '@_user_1', name: 'LightClaw', id: { open_id: BOT_ID } },
      ],
    }), BOT_ID)

    assert.ok(result, 'pure @bot inbound must not be dropped')
    assert.equal(result.text, '')
    assert.equal(result.chatId, 'oc_test')
    assert.equal(result.chatType, 'group')
    assert.equal(result.parentId, 'om_webhook_parent')
  })

  it('still drops empty messages without any bot mention', () => {
    const result = normalizeEvent(buildBody({ text: '' }), BOT_ID)
    assert.equal(result, null)
  })
})
