import { randomUUID } from 'node:crypto'

import type { NormalizedChannelMessage } from '../types.js'
import type { FeishuClient } from './client.js'

export const STREAMING_CARD_ELEMENT_ID = 'content'
export const STREAMING_UPDATE_THROTTLE_MS = 160
export const STREAMING_SIGNIFICANT_DELTA_CHARS = 18
// Hard cap on cardkit pushes per reply. Without it a long reply (textChunkSize
// defaults to 4000) flushes one push per 18 chars / per natural boundary —
// ~200+ cardkit calls and ~35s of throttle for one message, hammering the API
// and blocking the session lock. 24 pushes ≈ 3.7s of streaming regardless of length.
export const STREAMING_MAX_PUSHES = 24

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
    const fullText = snapshots[snapshots.length - 1] ?? text

    // Open separately: a failure here means no card message reached the chat,
    // so the caller is free to fall back to a whole-message reply. (card.create
    // can succeed while the message send fails — close the orphan card first.)
    try {
      await this.open(message)
    } catch (error) {
      await this.close(this.pushedText).catch(() => {})
      throw error
    }

    // The card message is now visible in the chat. From here we never throw: a
    // mid-stream push failure is recovered by completing the card in place,
    // because falling back to a whole-message reply would DUPLICATE a reply the
    // user can already see streaming. If even the recovery push fails the card
    // is left on its last good snapshot (best-effort streaming).
    try {
      for (let i = 0; i < snapshots.length; i += 1) {
        if (this.options.signal?.aborted) {
          break
        }
        await this.push(snapshots[i]!)
        if (i < snapshots.length - 1) {
          await delay(this.options.throttleMs ?? STREAMING_UPDATE_THROTTLE_MS, this.options.signal)
        }
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      process.stderr.write(`[feishu] streaming push failed mid-stream; completing card in place: ${detail}\n`)
      if (!this.options.signal?.aborted && this.pushedText !== fullText) {
        await this.push(fullText).catch(() => {})
      }
    }

    const aborted = this.options.signal?.aborted === true
    await this.close(this.pushedText).catch(() => {})
    return {
      cardId: this.cardId!,
      ...(this.messageId ? { messageId: this.messageId } : {}),
      pushes: this.pushes,
      finalSequence: this.sequence,
      aborted,
      text: this.pushedText,
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
  return capSnapshots(snapshots, STREAMING_MAX_PUSHES)
}

// Evenly downsample cumulative snapshots to at most `max`, always keeping the
// final full snapshot. Each kept entry is still a valid cumulative prefix, so
// the typewriter just advances in larger steps. Short replies (count <= max)
// are returned unchanged.
function capSnapshots(snapshots: string[], max: number): string[] {
  if (max <= 0 || snapshots.length <= max) {
    return snapshots
  }
  const sampled: string[] = []
  const step = (snapshots.length - 1) / (max - 1)
  for (let i = 0; i < max - 1; i += 1) {
    sampled.push(snapshots[Math.round(i * step)]!)
  }
  sampled.push(snapshots[snapshots.length - 1]!)
  // Rounding can collide on adjacent picks — drop consecutive duplicates.
  return sampled.filter((snapshot, index) => index === 0 || snapshot !== sampled[index - 1])
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
