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