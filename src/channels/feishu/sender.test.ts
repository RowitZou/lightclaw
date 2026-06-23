import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { FeishuChannelConfig, NormalizedChannelMessage } from '../types.js'
import type { FeishuClient } from './client.js'
import { PendingQueueStore } from './pending-queue.js'
import { FeishuSender } from './sender.js'

const baseConfig: FeishuChannelConfig = {
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
  parentFetchTimeoutMs: 8000,
  typingReaction: false,
  streamingReply: false,
  inboxAging: { enabled: false, ttlDays: 7, intervalMinutes: 60 },
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

test('sendMarkdownText sends a headerless schema 2.0 markdown card', async () => {
  const sent: Array<{ msg_type: string; content: string }> = []
  const client = {
    im: {
      message: {
        reply: async (input: { data: { msg_type: string; content: string } }) => {
          sent.push(input.data)
          return { code: 0, data: { message_id: 'om_reply' } }
        },
        create: async () => {
          throw new Error('reply path should succeed')
        },
      },
      file: { create: async () => null },
    },
  } as unknown as FeishuClient

  const sender = new FeishuSender(client, baseConfig)
  await sender.sendMarkdownText(baseMessage, '**hello**')

  assert.equal(sent.length, 1)
  assert.equal(sent[0]!.msg_type, 'interactive')
  const card = JSON.parse(sent[0]!.content)
  assert.equal(card.schema, '2.0')
  assert.equal('header' in card, false)
  assert.equal(card.body.elements[0].tag, 'markdown')
  assert.equal(card.body.elements[0].content, '**hello**')
})

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

test('FeishuSender falls back to create when the reply target is invalid (code 99992354)', async () => {
  let replyCalls = 0
  let createCalls = 0
  const client = {
    im: {
      message: {
        reply: async () => {
          replyCalls += 1
          return {
            code: 99992354,
            msg: 'The request you send is not a valid open_message_id or not exists',
          }
        },
        create: async () => {
          createCalls += 1
          return { code: 0, data: { message_id: 'om_created' } }
        },
      },
      file: { create: async () => null },
    },
  } as unknown as FeishuClient

  const sender = new FeishuSender(client, baseConfig, { baseDelayMs: 1 })
  await sender.sendInteractiveCard(baseMessage, { elements: [] })

  // 99992354 is a deterministic "reply target gone" envelope: attempted once
  // (no retry storm), then the message is delivered via create.
  assert.equal(replyCalls, 1)
  assert.equal(createCalls, 1)
})

test('FeishuSender replies against replyAnchorMessageId for synthetic messages', async () => {
  // Post-approval replay messages are synthetic (fabricated messageId the
  // platform never saw) but may carry the applicant's REAL original
  // messageId as replyAnchorMessageId. The sender must reply against the
  // anchor — in a topic group, im.message.reply is the only routing that
  // lands in the original topic; im.message.create would open a NEW topic
  // per message (2026-06-10 dogfood).
  let repliedTo: string | undefined
  let createCalls = 0
  const client = {
    im: {
      message: {
        reply: async (input: { path: { message_id: string } }) => {
          repliedTo = input.path.message_id
          return { code: 0, data: { message_id: 'om_replied' } }
        },
        create: async () => {
          createCalls += 1
          return { code: 0, data: { message_id: 'om_created' } }
        },
      },
      file: { create: async () => null },
    },
  } as unknown as FeishuClient

  const sender = new FeishuSender(client, baseConfig)
  const syntheticWithAnchor: NormalizedChannelMessage = {
    ...baseMessage,
    messageId: 'replay-fake-id',
    threadId: 'omt_topic_1',
    replyAnchorMessageId: 'om_original_at',
    synthetic: true,
  }
  await sender.sendInteractiveCard(syntheticWithAnchor, { elements: [] })

  assert.equal(repliedTo, 'om_original_at', 'reply anchored on the real original message')
  assert.equal(createCalls, 0, 'no create fallback — create would open a new topic')
})

test('FeishuSender anchor-less synthetic messages keep the create path', async () => {
  // Old pending.json shapes have no stashed messageId; the replay message
  // then has no anchor and must not attempt im.message.reply against its
  // fabricated messageId (the platform would 400).
  let replyCalls = 0
  let createCalls = 0
  const client = {
    im: {
      message: {
        reply: async () => {
          replyCalls += 1
          return { code: 0 }
        },
        create: async () => {
          createCalls += 1
          return { code: 0, data: { message_id: 'om_created' } }
        },
      },
      file: { create: async () => null },
    },
  } as unknown as FeishuClient

  const sender = new FeishuSender(client, baseConfig)
  const syntheticNoAnchor: NormalizedChannelMessage = {
    ...baseMessage,
    messageId: 'replay-fake-id',
    synthetic: true,
  }
  await sender.sendInteractiveCard(syntheticNoAnchor, { elements: [] })

  assert.equal(replyCalls, 0, 'fabricated messageId never hits the reply API')
  assert.equal(createCalls, 1)
})

test('FeishuSender never puts a non-om_ id on the reply wire (sender-side backstop)', async () => {
  // 2026-06-20 dogfood: a post-approval `synthesizeReplayMessage` placeholder
  // (`replay-<uuid>`) reached `messages/replay-.../reply` → `code=99992354 not
  // a valid {open_message_id}` → the reply was silently lost. Every upstream
  // synthetic short-circuit covers ONE leak path; this asserts the sender's
  // own `om_`-prefix backstop catches any id that slipped through, regardless
  // of which path minted it. Two shapes that 400 on the reply API:
  //   (a) synthetic message whose replyAnchorMessageId is itself a fake id
  //       (a leaked / chained anchor), and
  //   (b) a non-synthetic message carrying a `replay-` messageId (the flag was
  //       lost upstream). Both must fall back to im.message.create, not reply.
  for (const leaked of [
    { messageId: 'replay-a3f20c8d-5f2e', replyAnchorMessageId: 'replay-a3f20c8d-5f2e', synthetic: true },
    { messageId: 'replay-a3f20c8d-5f2e', synthetic: false },
  ] as const) {
    let repliedTo: string | undefined
    let createCalls = 0
    const client = {
      im: {
        message: {
          reply: async (input: { path: { message_id: string } }) => {
            repliedTo = input.path.message_id
            return { code: 0, data: { message_id: 'om_replied' } }
          },
          create: async () => {
            createCalls += 1
            return { code: 0, data: { message_id: 'om_created' } }
          },
        },
        file: { create: async () => null },
      },
    } as unknown as FeishuClient

    const sender = new FeishuSender(client, baseConfig)
    // No threadId — a DM, matching the dogfood incident; create fallback is safe.
    const message: NormalizedChannelMessage = { ...baseMessage, ...leaked }
    await sender.sendInteractiveCard(message, { elements: [] })

    assert.equal(repliedTo, undefined, 'a non-om_ id must never hit im.message.reply')
    assert.equal(createCalls, 1, 'the reply falls back to im.message.create')
  }
})

test('FeishuSender retries Feishu rate-limit envelopes on create message', async () => {
  let createCalls = 0
  const client = {
    im: {
      message: {
        reply: async () => {
          throw new Error('synthetic message should skip reply')
        },
        create: async () => {
          createCalls += 1
          if (createCalls === 1) {
            return { code: 11232, msg: 'message creation rate limited' }
          }
          return { code: 0, data: { message_id: 'om_created_after_retry' } }
        },
      },
      file: { create: async () => null },
    },
  } as unknown as FeishuClient

  const sender = new FeishuSender(client, baseConfig, { baseDelayMs: 1 })
  await sender.sendInteractiveCard({ ...baseMessage, synthetic: true }, { elements: [] })

  assert.equal(createCalls, 2)
})

test('attached pending store enqueues on transient retry exhaustion instead of throwing', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lightclaw-sender-pending-test-'))
  try {
    const transient = new Error('Client network socket disconnected') as Error & { code: string }
    transient.code = 'ECONNRESET'
    const client = {
      im: {
        message: {
          reply: async () => { throw transient },
          create: async () => { throw transient },
        },
        file: { create: async () => null },
      },
    } as unknown as FeishuClient
    const store = new PendingQueueStore(dir)
    const sender = new FeishuSender(client, baseConfig, { baseDelayMs: 1, attempts: 2 })
    sender.attachPendingStore(store)

    // Without the store, this would throw after retries exhausted. With the
    // store wired, the failure is swallowed and the payload is queued.
    await sender.sendInteractiveCardToOpenId('ou_recipient', { elements: [] }, {
      purpose: 'welcome',
      canonicalUser: 'alice',
    })

    const alive = await store.loadAlive()
    assert.equal(alive.length, 1)
    assert.equal(alive[0]!.purpose, 'welcome')
    assert.equal(alive[0]!.canonicalUser, 'alice')
    assert.equal(alive[0]!.recipient.type, 'open_id')
    if (alive[0]!.recipient.type === 'open_id') {
      assert.equal(alive[0]!.recipient.openId, 'ou_recipient')
    }
    assert.equal(alive[0]!.payload.kind, 'card')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('attached pending store does NOT enqueue non-transient failures', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lightclaw-sender-pending-test-'))
  try {
    const client = {
      im: {
        message: {
          reply: async () => { throw new Error('not used') },
          create: async () => ({ code: 99991661, msg: 'invalid app credential' }),
        },
        file: { create: async () => null },
      },
    } as unknown as FeishuClient
    const store = new PendingQueueStore(dir)
    const sender = new FeishuSender(client, baseConfig)
    sender.attachPendingStore(store)

    await assert.rejects(
      () => sender.sendInteractiveCardToOpenId('ou_recipient', { elements: [] }),
      /invalid app credential/,
    )

    // 4xx-style business errors are not transient and must NOT pile into
    // the queue (they would never drain).
    assert.equal(await store.sizeForTest(), 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('multi-chunk text send queues remaining chunks when the first chunk fails transiently', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lightclaw-sender-pending-test-'))
  try {
    const transient = new Error('socket hang up') as Error & { code: string }
    transient.code = 'ECONNRESET'
    const client = {
      im: {
        message: {
          reply: async () => { throw transient },
          create: async () => { throw transient },
        },
        file: { create: async () => null },
      },
    } as unknown as FeishuClient
    const store = new PendingQueueStore(dir)
    const sender = new FeishuSender(
      client,
      { ...baseConfig, textChunkSize: 10 },
      { baseDelayMs: 1, attempts: 2 },
    )
    sender.attachPendingStore(store)

    // 25 chars / chunkSize 10 → 3 chunks. First chunk fails → all 3
    // should land in the queue.
    await sender.sendText(baseMessage, '0123456789ABCDEFGHIJKLMNO', {
      purpose: 'reply',
      canonicalUser: 'alice',
    })

    const alive = await store.loadAlive()
    assert.equal(alive.length, 3)
    for (const n of alive) {
      assert.equal(n.purpose, 'reply')
      assert.equal(n.payload.kind, 'text')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// Topic-group thread routing. Feishu topic groups attach every outbound
// message to a thread. The reply API (keyed on message_id) keeps a reply in
// the parent's thread automatically, so reply-path delivery is correct
// without further help. The create API, however, only accepts
// receive_id_type ∈ {open_id, user_id, union_id, email, chat_id} — there is
// no `thread_id` value (sender.ts previously cast 'thread_id' through; the
// Feishu API responds 400 with `field validation failed, options:[…5 values…]`
// 100% of the time). The only safe fallback would be `chat_id`, but that
// silently creates a NEW topic in the same group, which is worse than
// dropping the message: the user opened topic A and now sees the bot
// flooding their group with auto-created topics. Refusing to send is the
// chosen behavior; reply path stays unchanged.
test('reply→create fallback in a topic group refuses to send instead of creating a new topic', async () => {
  let createCalls = 0
  const client = {
    im: {
      message: {
        reply: async () => ({
          code: 99992354,
          msg: 'The request you send is not a valid open_message_id or not exists',
        }),
        create: async () => {
          createCalls += 1
          return { code: 0, data: { message_id: 'om_should_not_be_called' } }
        },
      },
      file: { create: async () => null },
    },
  } as unknown as FeishuClient

  const sender = new FeishuSender(client, baseConfig, { baseDelayMs: 1 })
  // Should resolve without throwing — the refusal is swallowed at the
  // public sender entry, the same way task-card / Notify
  // / askuser-card already swallow send failures.
  await sender.sendInteractiveCard(
    { ...baseMessage, chatType: 'group', threadId: 'omt_topic42' },
    { elements: [] },
  )

  assert.equal(createCalls, 0, 'create must not be called in a topic group when reply fails')
})

test('sendInteractiveCardToChatId refuses to send when threadId is supplied (no reply anchor available)', async () => {
  let createCalls = 0
  let replyCalls = 0
  const client = {
    im: {
      message: {
        reply: async () => { replyCalls += 1; throw new Error('reply must not be called when no replyToMessageId') },
        create: async () => {
          createCalls += 1
          return { code: 0, data: { message_id: 'om_should_not_be_called' } }
        },
      },
      file: { create: async () => null },
    },
  } as unknown as FeishuClient

  const sender = new FeishuSender(client, baseConfig, { baseDelayMs: 1 })
  await sender.sendInteractiveCardToChatId('oc_chat', { elements: [] }, undefined, 'omt_topic88')

  assert.equal(replyCalls, 0, 'no inbound message to reply against')
  assert.equal(createCalls, 0, 'create must not be called — would auto-create a new topic')
})

test('sendMarkdownTextToChatId refuses to send when threadId is supplied (no reply anchor available)', async () => {
  let createCalls = 0
  const client = {
    im: {
      message: {
        reply: async () => { throw new Error('reply must not be called when no replyToMessageId') },
        create: async () => {
          createCalls += 1
          return { code: 0, data: { message_id: 'om_should_not_be_called' } }
        },
      },
      file: { create: async () => null },
    },
  } as unknown as FeishuClient

  const sender = new FeishuSender(client, baseConfig, { baseDelayMs: 1 })
  await sender.sendMarkdownTextToChatId('oc_chat', 'hello topic', undefined, 'omt_topic99')

  assert.equal(createCalls, 0, 'create must not be called — would auto-create a new topic')
})

test('reply→create fallback keeps receive_id_type=chat_id when no threadId is present', async () => {
  let createCalls: Array<{ params: unknown; data: { receive_id: string } }> = []
  const client = {
    im: {
      message: {
        reply: async () => ({
          code: 99992354,
          msg: 'reply target gone',
        }),
        create: async (input: unknown) => {
          createCalls.push(input as { params: unknown; data: { receive_id: string } })
          return { code: 0, data: { message_id: 'om_chat' } }
        },
      },
      file: { create: async () => null },
    },
  } as unknown as FeishuClient

  const sender = new FeishuSender(client, baseConfig, { baseDelayMs: 1 })
  await sender.sendInteractiveCard(
    { ...baseMessage, chatType: 'group' /* no threadId */ },
    { elements: [] },
  )

  assert.equal(createCalls.length, 1)
  assert.deepEqual(createCalls[0]!.params, { receive_id_type: 'chat_id' })
  assert.equal(createCalls[0]!.data.receive_id, 'oc_chat')
})

// --- Send idempotency (2026-06-01 duplicate "记下了" spam) ---
// Root cause: im.message.reply/create were retried on transient errors
// (ECONNRESET / read timeout — a request that LANDED server-side but whose
// response was lost) WITHOUT a uuid, so each retry created a fresh chat
// message. One flaky-network ack fanned out into ~7 reply copies + N create
// copies. Fix: one stable `data.uuid` per logical message, reused across
// every retry and shared between the reply path and its create fallback, so
// Feishu's 1h server-side dedup collapses the re-sends.

const uuidOf = (input: unknown): unknown =>
  (input as { data?: { uuid?: unknown } }).data?.uuid

test('a logical send reuses ONE idempotency uuid across reply retries and the create fallback', async () => {
  const replyUuids: unknown[] = []
  const createUuids: unknown[] = []
  const transient = new Error('socket hang up') as Error & { code: string }
  transient.code = 'ECONNRESET'
  const client = {
    im: {
      message: {
        reply: async (input: unknown) => {
          replyUuids.push(uuidOf(input))
          throw transient
        },
        create: async (input: unknown) => {
          createUuids.push(uuidOf(input))
          return { code: 0, data: { message_id: 'om_created' } }
        },
      },
      file: { create: async () => null },
    },
  } as unknown as FeishuClient

  const sender = new FeishuSender(client, baseConfig, { baseDelayMs: 1, attempts: 3 })
  await sender.sendInteractiveCard(baseMessage, { elements: [] })

  // Every reply retry carries a uuid, and it is the SAME value every time —
  // that is what lets Feishu dedup the re-sent-after-lost-response copies.
  // Pre-fix every uuid was `undefined`, so this whole block fails.
  assert.equal(replyUuids.length, 3)
  for (const u of replyUuids) assert.equal(typeof u, 'string')
  assert.equal(new Set(replyUuids).size, 1)
  // The create fallback shares the SAME key, so a reply that actually landed
  // (lost response) is deduped rather than duplicated as a second message.
  assert.equal(createUuids.length, 1)
  assert.equal(createUuids[0], replyUuids[0])
})

test('distinct logical sends use distinct idempotency uuids (legit messages are not collapsed)', async () => {
  const createUuids: unknown[] = []
  const client = {
    im: {
      message: {
        reply: async () => { throw new Error('should not be called') },
        create: async (input: unknown) => {
          createUuids.push(uuidOf(input))
          return { code: 0, data: { message_id: 'om_created' } }
        },
      },
      file: { create: async () => null },
    },
  } as unknown as FeishuClient

  const sender = new FeishuSender(client, baseConfig, { baseDelayMs: 1 })
  const synthetic = { ...baseMessage, synthetic: true } as NormalizedChannelMessage
  await sender.sendInteractiveCard(synthetic, { elements: [] })
  await sender.sendInteractiveCard(synthetic, { elements: [] })

  assert.equal(createUuids.length, 2)
  for (const u of createUuids) assert.equal(typeof u, 'string')
  assert.notEqual(createUuids[0], createUuids[1])
})

test('a drained pending notice replays under the ORIGINAL idempotency uuid', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lightclaw-sender-idem-test-'))
  try {
    const transient = new Error('Client network socket disconnected') as Error & { code: string }
    transient.code = 'ECONNRESET'
    const createUuids: unknown[] = []
    let failCreate = true
    const client = {
      im: {
        message: {
          reply: async () => { throw transient },
          create: async (input: unknown) => {
            createUuids.push(uuidOf(input))
            if (failCreate) throw transient
            return { code: 0, data: { message_id: 'om_created' } }
          },
        },
        file: { create: async () => null },
      },
    } as unknown as FeishuClient
    const store = new PendingQueueStore(dir)
    const sender = new FeishuSender(client, baseConfig, { baseDelayMs: 1, attempts: 2 })
    sender.attachPendingStore(store)

    await sender.sendInteractiveCardToOpenId('ou_recipient', { elements: [] }, {
      purpose: 'welcome',
    })
    const inProcessUuid = createUuids[0]
    assert.equal(typeof inProcessUuid, 'string')
    assert.ok(createUuids.every(u => u === inProcessUuid))

    const alive = await store.loadAlive()
    assert.equal(alive.length, 1)
    assert.equal(alive[0]!.payload.uuid, inProcessUuid)

    createUuids.length = 0
    failCreate = false
    await sender.sendForDrain(alive[0]!)
    assert.equal(createUuids.length, 1)
    assert.equal(createUuids[0], inProcessUuid)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
