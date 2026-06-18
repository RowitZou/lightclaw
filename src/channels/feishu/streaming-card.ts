import { randomUUID } from 'node:crypto'

import type { NormalizedChannelMessage } from '../types.js'
import type { FeishuClient } from './client.js'

export const STREAMING_CARD_ELEMENT_ID = 'content'
export const STREAMING_UPDATE_THROTTLE_MS = 160
export const STREAMING_SIGNIFICANT_DELTA_CHARS = 18

const STREAMING_REPLY_SUMMARY = 'LightClaw reply'
const NATURAL_FLUSH_BOUNDARY = /[。！？；;:、\n]$/u

type LarkResponse<T extends object = Record<string, never>> = {
  code?: number
  msg?: string
  data?: T
}

export type SendCardkitReference = (
  message: NormalizedChannelMessage,
  cardId: string,
) => Promise<{ messageId?: string }>

export type CardKitStreamSessionOptions = {
  client: FeishuClient
  sendCardReference: SendCardkitReference
  throttleMs?: number
  signal?: AbortSignal
}

export type CardKitStreamResult = {
  cardId: string
  messageId?: string
  pushes: number
  finalSequence: number
  aborted: boolean
  text: string
}

export class CardKitStreamSession {
  private cardId: string | null = null
  private messageId: string | undefined
  private sequence = 0
  private pushedText = ''
  private pushes = 0
  private closed = false

  constructor(private readonly options: CardKitStreamSessionOptions) {}

  async streamText(
    message: NormalizedChannelMessage,
    text: string,
  ): Promise<CardKitStreamResult> {
    const snapshots = buildStreamingFlushSnapshots(text)
    try {
      await this.open(message)
      for (let i = 0; i < snapshots.length; i += 1) {
        if (this.options.signal?.aborted) {
          break
        }
        await this.push(snapshots[i]!)
        if (i < snapshots.length - 1) {
          await delay(this.options.throttleMs ?? STREAMING_UPDATE_THROTTLE_MS, this.options.signal)
        }
      }
      const aborted = this.options.signal?.aborted === true
      await this.close(this.pushedText)
      return {
        cardId: this.cardId!,
        ...(this.messageId ? { messageId: this.messageId } : {}),
        pushes: this.pushes,
        finalSequence: this.sequence,
        aborted,
        text: this.pushedText,
      }
    } catch (error) {
      if (this.options.signal?.aborted) {
        await this.close(this.pushedText).catch(() => {})
        return {
          cardId: this.cardId ?? '',
          ...(this.messageId ? { messageId: this.messageId } : {}),
          pushes: this.pushes,
          finalSequence: this.sequence,
          aborted: true,
          text: this.pushedText,
        }
      }
      await this.close(this.pushedText).catch(() => {})
      throw error
    }
  }

  private async open(message: NormalizedChannelMessage): Promise<void> {
    const created = await this.options.client.cardkit.v1.card.create({
      data: {
        type: 'card_json',
        data: JSON.stringify(buildStreamingReplyCard()),
      },
    })
    assertOk(created, 'cardkit create failed')
    const cardId = created.data?.card_id
    if (!cardId) {
      throw new Error('cardkit create failed: missing card_id')
    }
    this.cardId = cardId
    const sent = await this.options.sendCardReference(message, cardId)
    this.messageId = sent.messageId
  }

  private async push(content: string): Promise<void> {
    if (!this.cardId) {
      throw new Error('cardkit push before open')
    }
    this.sequence += 1
    const pushed = await this.options.client.cardkit.v1.cardElement.content({
      path: { card_id: this.cardId, element_id: STREAMING_CARD_ELEMENT_ID },
      data: { content, sequence: this.sequence, uuid: randomUUID() },
    })
    assertOk(pushed, 'cardkit content push failed')
    this.pushedText = content
    this.pushes += 1
  }

  private async close(summaryText: string): Promise<void> {
    if (!this.cardId || this.closed) {
      return
    }
    this.closed = true
    this.sequence += 1
    const closed = await this.options.client.cardkit.v1.card.settings({
      path: { card_id: this.cardId },
      data: {
        settings: buildStreamingCloseSettings(summaryText),
        sequence: this.sequence,
        uuid: randomUUID(),
      },
    })
    assertOk(closed, 'cardkit close settings failed')
  }
}

export function buildStreamingReplyCard(summary = STREAMING_REPLY_SUMMARY): Record<string, unknown> {
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      streaming_mode: true,
      summary: { content: summary },
      streaming_config: {
        print_frequency_ms: { default: 50 },
        print_step: { default: 1 },
      },
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          element_id: STREAMING_CARD_ELEMENT_ID,
          content: '',
        },
      ],
    },
  }
}

export function buildCardkitCardReferenceContent(cardId: string): string {
  return JSON.stringify({ type: 'card', data: { card_id: cardId } })
}

export function buildStreamingCloseSettings(summaryText: string): string {
  return JSON.stringify({
    config: {
      streaming_mode: false,
      summary: { content: truncateSummary(summaryText) },
    },
  })
}

export function mergeStreamingText(prev: string, next: string): string {
  if (next.startsWith(prev)) {
    return next
  }
  const maxOverlap = Math.min(prev.length, next.length)
  for (let size = maxOverlap; size > 0; size -= 1) {
    if (prev.endsWith(next.slice(0, size))) {
      return prev + next.slice(size)
    }
  }
  return prev + next
}

export function buildStreamingFlushSnapshots(text: string): string[] {
  const normalized = text.trim() || '(empty)'
  const snapshots: string[] = []
  let lastFlushedLength = 0
  for (let i = 1; i <= normalized.length; i += 1) {
    const current = normalized.slice(0, i)
    const delta = i - lastFlushedLength
    if (
      snapshots.length === 0 ||
      NATURAL_FLUSH_BOUNDARY.test(current) ||
      delta >= STREAMING_SIGNIFICANT_DELTA_CHARS
    ) {
      snapshots.push(current)
      lastFlushedLength = i
    }
  }
  if (snapshots[snapshots.length - 1] !== normalized) {
    snapshots.push(normalized)
  }
  return snapshots
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

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) {
    return Promise.resolve()
  }
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
