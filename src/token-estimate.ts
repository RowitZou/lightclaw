import type { AssistantContentBlock, Message } from './types.js'

export function estimateTokens(text: string): number {
  if (text.length === 0) {
    return 0
  }

  let total = 0
  for (const character of text) {
    total += character.charCodeAt(0) <= 0x7f ? 0.25 : 0.5
  }

  return Math.max(1, Math.ceil(total))
}

/**
 * Inline base64 media is wildly cheaper on the wire than its character count
 * suggests — Anthropic charges vision by patch grid (≤~1600 tokens for the
 * largest supported image) and PDFs roughly per page. The previous
 * `base64.length / 16` heuristic over-counted by 10x on a single 8 MB PDF
 * (515k est tokens vs 50k upstream), tripping compact long before the real
 * context window pressure showed up. Cap per-image at 2000 and per-document
 * at 50k, with a base64-proportional fallback for small/medium payloads.
 */
function estimateMediaTokens(base64Length: number, kind: 'image' | 'document'): number {
  if (kind === 'image') {
    return Math.min(2000, Math.ceil(base64Length / 64))
  }
  return Math.min(50_000, Math.ceil(base64Length / 800))
}

function estimateAssistantBlockTokens(block: AssistantContentBlock): number {
  if (block.type === 'text') {
    return estimateTokens(block.text)
  }
  if (block.type === 'tool_use') {
    return estimateTokens(`${block.name}\n${JSON.stringify(block.input)}`)
  }
  if (block.type === 'thinking') {
    return estimateTokens(block.thinking)
  }
  // redacted_thinking: server-side opaque blob; estimate from data length so
  // the compact threshold still accounts for its bytes on the wire.
  return estimateTokens(block.data)
}

export function estimateMessageTokens(message: Message): number {
  if (message.type === 'system') {
    return estimateTokens(message.message.summary) + 4
  }

  if (message.type === 'user') {
    if (typeof message.message.content === 'string') {
      return estimateTokens(message.message.content) + 4
    }

    let mediaTokens = 0
    const userBlockText = message.message.content
      .map(block => {
        if (block.type === 'tool_result') {
          if (typeof block.content === 'string') {
            return `${block.tool_use_id}\n${block.content}`
          }
          const inner = block.content.map(inner => {
            if (inner.type === 'text') return inner.text
            if (inner.type === 'image') {
              mediaTokens += estimateMediaTokens(inner.source.data.length, 'image')
            }
            return ''
          }).join('\n')
          return `${block.tool_use_id}\n${inner}`
        }
        if (block.type === 'text') {
          return block.text
        }
        if (block.type === 'image' || block.type === 'document') {
          mediaTokens += estimateMediaTokens(block.source.data.length, block.type)
        }
        return ''
      })
      .join('\n')
    return estimateTokens(userBlockText) + mediaTokens + 4
  }

  return (
    message.message.content.reduce(
      (total, block) => total + estimateAssistantBlockTokens(block),
      0,
    ) + 4
  )
}

export function estimateMessagesTokens(messages: Message[]): number {
  return messages.reduce(
    (total, message) => total + estimateMessageTokens(message),
    0,
  )
}

const CALIBRATION_MIN = 0.5
const CALIBRATION_MAX = 5.0

/**
 * Project how many input tokens the NEXT request to the provider will
 * actually be billed. Anchor the projection on the most recent
 * `assistant.usage.input_tokens` we have seen — that is the wire-truth
 * for the slice the provider already processed — and estimate only what
 * has been added since (the anchor's own response plus any new user /
 * tool_result messages). The estimator's known per-session bias is
 * recovered from `anchor.input_tokens / estimate(prefix)` and applied to
 * the un-sent tail so the threshold judgement reflects upstream pressure
 * instead of our local under-count (estimator runs 1.17-3.68x low on
 * codex / multimodal sessions in 2026-05-26 dogfood data).
 *
 * Falls back to pure `estimateMessagesTokens` when no usable anchor
 * exists (cold start; assistant turns that errored with empty usage).
 * The calibration multiplier is clamped to [0.5, 5.0] so a pathological
 * anchor (recovered transcript with a stale or otherwise weird usage
 * record) cannot blow the projection past sanity.
 */
export function estimateProjectedInputTokens(messages: Message[]): number {
  const anchorIdx = findAnchorIndex(messages)
  if (anchorIdx < 0) {
    return estimateMessagesTokens(messages)
  }
  const anchor = messages[anchorIdx]! as AssistantMessageRef
  const anchorInput = anchor.message.usage.input_tokens ?? 0

  const prefixEstimate = estimateMessagesTokens(messages.slice(0, anchorIdx))
  const calibration =
    prefixEstimate > 0
      ? Math.min(
          CALIBRATION_MAX,
          Math.max(CALIBRATION_MIN, anchorInput / prefixEstimate),
        )
      : 1.0

  let tailEstimate = estimateMessageTokens(anchor)
  for (let i = anchorIdx + 1; i < messages.length; i += 1) {
    tailEstimate += estimateMessageTokens(messages[i]!)
  }

  return anchorInput + Math.ceil(tailEstimate * calibration)
}

type AssistantMessageRef = Extract<Message, { type: 'assistant' }>

function findAnchorIndex(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]
    if (m && m.type === 'assistant') {
      const it = m.message.usage.input_tokens
      if (typeof it === 'number' && it > 0) {
        return i
      }
    }
  }
  return -1
}
