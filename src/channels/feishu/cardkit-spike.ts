import { randomUUID } from 'node:crypto'

import type { FeishuClient } from './client.js'

const STREAM_ELEMENT_ID = 'content'
const DEFAULT_SUMMARY = 'LightClaw cardkit streaming spike'

type LarkResponse<T extends object = Record<string, never>> = {
  code?: number
  msg?: string
  data?: T
}

export type CardkitStreamingSpikeOptions = {
  chatId: string
  replyToMessageId?: string
  text: string
  delayMs?: number
  summary?: string
  log?: (line: string) => void
}

export type CardkitStreamingSpikeResult = {
  cardId: string
  messageId?: string
  pushes: number
  finalSequence: number
}

export function buildCardkitStreamingSpikeCard(summary = DEFAULT_SUMMARY): Record<string, unknown> {
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      streaming_mode: true,
      summary: { content: summary },
      streaming_config: {
        print_frequency_ms: { default: 50 },
      },
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          element_id: STREAM_ELEMENT_ID,
          content: '',
        },
      ],
    },
  }
}

export function buildCardkitCardReferenceContent(cardId: string): string {
  return JSON.stringify({ type: 'card', data: { card_id: cardId } })
}

export function buildCardkitCloseSettings(summary: string): string {
  return JSON.stringify({
    config: {
      streaming_mode: false,
      summary: { content: truncateSummary(summary) },
    },
  })
}

export function splitStreamingSpikeText(text: string): string[] {
  const normalized = text.trim() || 'LightClaw cardkit streaming spike.'
  const chunks = normalized.match(/.{1,24}/gs) ?? [normalized]
  return chunks
}

export async function runCardkitStreamingSpike(
  client: FeishuClient,
  options: CardkitStreamingSpikeOptions,
): Promise<CardkitStreamingSpikeResult> {
  const chunks = splitStreamingSpikeText(options.text)
  const summary = options.summary ?? DEFAULT_SUMMARY
  const log = options.log ?? (() => {})
  const delayMs = options.delayMs ?? 350

  const cardJson = buildCardkitStreamingSpikeCard(summary)
  log('cardkit.v1.card.create')
  const created = await client.cardkit.v1.card.create({
    data: { type: 'card_json', data: JSON.stringify(cardJson) },
  })
  assertOk(created, 'cardkit create failed')
  const cardId = created.data?.card_id
  if (!cardId) {
    throw new Error('cardkit create failed: missing card_id')
  }
  log(`card_id=${cardId}`)

  const content = buildCardkitCardReferenceContent(cardId)
  const sent = options.replyToMessageId
    ? await client.im.message.reply({
        path: { message_id: options.replyToMessageId },
        data: { msg_type: 'interactive', content, uuid: randomUUID() },
      })
    : await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: options.chatId,
          msg_type: 'interactive',
          content,
          uuid: randomUUID(),
        },
      })
  assertOk(sent, 'send cardkit card message failed')
  const messageId = sent.data?.message_id
  log(`message_id=${messageId ?? '(missing)'}`)

  let sequence = 0
  let cumulative = ''
  for (const chunk of chunks) {
    cumulative += chunk
    sequence += 1
    log(`cardkit.v1.cardElement.content sequence=${sequence} chars=${cumulative.length}`)
    const pushed = await client.cardkit.v1.cardElement.content({
      path: { card_id: cardId, element_id: STREAM_ELEMENT_ID },
      data: { content: cumulative, sequence, uuid: randomUUID() },
    })
    assertOk(pushed, 'cardkit content push failed')
    if (delayMs > 0) {
      await delay(delayMs)
    }
  }

  sequence += 1
  log(`cardkit.v1.card.settings sequence=${sequence}`)
  const closed = await client.cardkit.v1.card.settings({
    path: { card_id: cardId },
    data: {
      settings: buildCardkitCloseSettings(cumulative),
      sequence,
      uuid: randomUUID(),
    },
  })
  assertOk(closed, 'cardkit close settings failed')

  return {
    cardId,
    ...(messageId ? { messageId } : {}),
    pushes: chunks.length,
    finalSequence: sequence,
  }
}

function assertOk<T extends object>(
  response: LarkResponse<T>,
  label: string,
): asserts response is LarkResponse<T> & { code: 0 } {
  if (response?.code !== 0) {
    throw new Error(`${label}: ${response?.code ?? 'missing-code'} ${response?.msg ?? ''}`.trim())
  }
}

function truncateSummary(text: string): string {
  return text.length > 120 ? `${text.slice(0, 117)}...` : text
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
