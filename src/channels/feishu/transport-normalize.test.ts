import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { normalizeReceiveV1, normalizeRecalledV1 } from './transport-ws.js'
import { normalizeEvent, normalizeRecallEvent } from './transport-webhook.js'

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

describe('recall event normalization', () => {
  it('normalizeRecalledV1 extracts messageId + chatId from a ws recall event', () => {
    const recall = normalizeRecalledV1({
      event_id: 'evt-recall-1',
      message_id: 'om_recalled',
      chat_id: 'oc_test',
      recall_time: '1700000000',
      recall_type: 'message_owner',
    })
    assert.ok(recall)
    assert.equal(recall.eventId, 'evt-recall-1')
    assert.equal(recall.messageId, 'om_recalled')
    assert.equal(recall.chatId, 'oc_test')
  })

  it('normalizeRecalledV1 falls back to a recall:-prefixed eventId when event_id is absent', () => {
    const recall = normalizeRecalledV1({ message_id: 'om_x', chat_id: 'oc_y' })
    assert.ok(recall)
    // The recall: prefix keeps this dedup key from colliding with a
    // receive_v1 claim that also fell back to a bare message_id.
    assert.equal(recall.eventId, 'recall:om_x')
  })

  it('normalizeRecalledV1 returns null without message_id or chat_id', () => {
    assert.equal(normalizeRecalledV1({ message_id: 'om_x' }), null)
    assert.equal(normalizeRecalledV1({ chat_id: 'oc_y' }), null)
    assert.equal(normalizeRecalledV1({}), null)
  })

  it('normalizeRecallEvent reads the im.message.recalled_v1 webhook envelope', () => {
    const recall = normalizeRecallEvent({
      header: { event_type: 'im.message.recalled_v1', event_id: 'evt-w-1' },
      event: { message_id: 'om_w', chat_id: 'oc_w', recall_type: 'message_owner' },
    })
    assert.ok(recall)
    assert.equal(recall.eventId, 'evt-w-1')
    assert.equal(recall.messageId, 'om_w')
    assert.equal(recall.chatId, 'oc_w')
  })

  it('normalizeRecallEvent returns null for non-recall webhook envelopes', () => {
    const result = normalizeRecallEvent({
      header: { event_type: 'im.message.receive_v1' },
      event: { message: { message_id: 'm', chat_id: 'c' } },
    })
    assert.equal(result, null)
  })
})
