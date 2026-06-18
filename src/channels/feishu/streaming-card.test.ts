import test from 'node:test'
import assert from 'node:assert/strict'

import type { NormalizedChannelMessage } from '../types.js'
import type { FeishuClient } from './client.js'
import {
  buildCardkitCardReferenceContent,
  buildStreamingCloseSettings,
  buildStreamingFlushSnapshots,
  buildStreamingReplyCard,
  CardKitStreamSession,
  mergeStreamingText,
  STREAMING_MAX_PUSHES,
} from './streaming-card.js'

const message: NormalizedChannelMessage = {
  channel: 'feishu',
  eventId: 'evt',
  chatId: 'oc_chat',
  senderOpenId: 'ou_sender',
  messageId: 'om_source',
  text: 'hello',
}

test('streaming reply card carries the dogfood-required print_step', () => {
  const card = buildStreamingReplyCard('summary')

  assert.equal(card.schema, '2.0')
  assert.deepEqual(card.config, {
    update_multi: true,
    streaming_mode: true,
    summary: { content: 'summary' },
    streaming_config: {
      print_frequency_ms: { default: 50 },
      print_step: { default: 1 },
    },
  })
  assert.deepEqual(card.body, {
    elements: [
      {
        tag: 'markdown',
        element_id: 'content',
        content: '',
      },
    ],
  })
})

test('streaming reply uses card_id reference content and close settings', () => {
  assert.equal(
    buildCardkitCardReferenceContent('card_1'),
    JSON.stringify({ type: 'card', data: { card_id: 'card_1' } }),
  )
  const settings = JSON.parse(buildStreamingCloseSettings('x'.repeat(150))) as {
    config: { streaming_mode: boolean; summary: { content: string } }
  }
  assert.equal(settings.config.streaming_mode, false)
  assert.equal(settings.config.summary.content.length, 120)
  assert.match(settings.config.summary.content, /\.\.\.$/)
})

test('mergeStreamingText dedupes snapshot prefixes and overlapping tails', () => {
  assert.equal(mergeStreamingText('你好', '你好，世界'), '你好，世界')
  assert.equal(mergeStreamingText('abcde', 'defgh'), 'abcdefgh')
  assert.equal(mergeStreamingText('abc', 'XYZ'), 'abcXYZ')
})

test('buildStreamingFlushSnapshots flushes first char, natural boundaries, thresholds, and final tail', () => {
  assert.deepEqual(buildStreamingFlushSnapshots('abcdef'), ['a', 'abcdef'])
  assert.deepEqual(
    buildStreamingFlushSnapshots('你好。继续写下去直到超过阈值吧'),
    ['你', '你好。', '你好。继续写下去直到超过阈值吧'],
  )
  assert.deepEqual(
    buildStreamingFlushSnapshots('1234567890123456789'),
    ['1', '1234567890123456789'],
  )
})

test('CardKitStreamSession pushes cumulative content and carries sequence through close', async () => {
  const pushed: Array<{ content: string; sequence: number }> = []
  const closed: Array<{ sequence: number; settings: string }> = []
  const client = fakeCardkitClient({
    content: async input => {
      pushed.push({ content: input.data.content, sequence: input.data.sequence })
      return { code: 0 }
    },
    settings: async input => {
      closed.push({ sequence: input.data.sequence, settings: input.data.settings })
      return { code: 0 }
    },
  })
  const sent: string[] = []
  const session = new CardKitStreamSession({
    client,
    throttleMs: 0,
    sendCardReference: async (_message, cardId) => {
      sent.push(cardId)
      return { messageId: 'om_stream' }
    },
  })

  const result = await session.streamText(message, 'abcdef')

  assert.deepEqual(sent, ['card_1'])
  assert.deepEqual(pushed, [
    { content: 'a', sequence: 1 },
    { content: 'abcdef', sequence: 2 },
  ])
  assert.equal(closed.length, 1)
  assert.equal(closed[0]!.sequence, 3)
  assert.equal(JSON.parse(closed[0]!.settings).config.summary.content, 'abcdef')
  assert.deepEqual(result, {
    cardId: 'card_1',
    messageId: 'om_stream',
    pushes: 2,
    finalSequence: 3,
    aborted: false,
    text: 'abcdef',
  })
})

test('CardKitStreamSession stops pushing on abort and closes accumulated text', async () => {
  const controller = new AbortController()
  const pushed: string[] = []
  const closed: string[] = []
  const client = fakeCardkitClient({
    content: async input => {
      pushed.push(input.data.content)
      controller.abort()
      return { code: 0 }
    },
    settings: async input => {
      closed.push(JSON.parse(input.data.settings).config.summary.content)
      return { code: 0 }
    },
  })
  const session = new CardKitStreamSession({
    client,
    throttleMs: 0,
    signal: controller.signal,
    sendCardReference: async () => ({}),
  })

  const result = await session.streamText(message, 'abcdefghijklmnopqrstuvwxyz')

  assert.deepEqual(pushed, ['a'])
  assert.deepEqual(closed, ['a'])
  assert.equal(result.aborted, true)
})

test('buildStreamingFlushSnapshots caps push count for long and boundary-heavy text', () => {
  const long = 'a'.repeat(4000)
  const longSnaps = buildStreamingFlushSnapshots(long)
  assert.ok(longSnaps.length <= STREAMING_MAX_PUSHES, `expected <= ${STREAMING_MAX_PUSHES}, got ${longSnaps.length}`)
  assert.equal(longSnaps[longSnaps.length - 1], long) // final full text always kept
  for (let i = 1; i < longSnaps.length; i += 1) {
    assert.ok(longSnaps[i]!.length > longSnaps[i - 1]!.length)
    assert.ok(longSnaps[i]!.startsWith(longSnaps[i - 1]!))
  }

  const boundaryHeavy = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n')
  const heavySnaps = buildStreamingFlushSnapshots(boundaryHeavy)
  assert.ok(heavySnaps.length <= STREAMING_MAX_PUSHES, `expected <= ${STREAMING_MAX_PUSHES}, got ${heavySnaps.length}`)
  assert.equal(heavySnaps[heavySnaps.length - 1], boundaryHeavy)
})

test('CardKitStreamSession completes the card in place on a mid-stream push failure (no throw)', async () => {
  const full = 'a'.repeat(50)
  let calls = 0
  const pushed: string[] = []
  const client = fakeCardkitClient({
    content: async input => {
      calls += 1
      if (calls === 2) {
        throw new Error('transient push failure')
      }
      pushed.push(input.data.content)
      return { code: 0 }
    },
  })
  const session = new CardKitStreamSession({
    client,
    throttleMs: 0,
    sendCardReference: async () => ({ messageId: 'om_stream' }),
  })

  // Must NOT throw — throwing makes the runner send a duplicate whole reply.
  const result = await session.streamText(message, full)

  assert.equal(result.aborted, false)
  assert.equal(result.text, full) // recovery push overwrote with the complete text
  assert.equal(pushed[pushed.length - 1], full)
})

test('CardKitStreamSession throws when the card never reaches the chat (caller falls back)', async () => {
  const client = fakeCardkitClient({})
  const session = new CardKitStreamSession({
    client,
    throttleMs: 0,
    sendCardReference: async () => {
      throw new Error('send failed')
    },
  })

  await assert.rejects(() => session.streamText(message, 'abcdef'), /send failed/)
})

function fakeCardkitClient(overrides: {
  content?: (input: { data: { content: string; sequence: number } }) => Promise<{ code: number }>
  settings?: (input: { data: { settings: string; sequence: number } }) => Promise<{ code: number }>
} = {}): FeishuClient {
  return {
    cardkit: {
      v1: {
        card: {
          create: async () => ({ code: 0, data: { card_id: 'card_1' } }),
          settings: overrides.settings ?? (async () => ({ code: 0 })),
        },
        cardElement: {
          content: overrides.content ?? (async () => ({ code: 0 })),
        },
      },
    },
  } as unknown as FeishuClient
}
