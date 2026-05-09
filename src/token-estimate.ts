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

    const userBlockText = message.message.content
      .map(block => {
        if (block.type === 'tool_result') {
          if (typeof block.content === 'string') {
            return `${block.tool_use_id}\n${block.content}`
          }
          // Array shape: text blocks contribute their text; image blocks
          // estimated by base64 payload like top-level images.
          const inner = block.content.map(inner => {
            if (inner.type === 'text') return inner.text
            if (inner.type === 'image') {
              return ''.padEnd(Math.floor(inner.source.data.length / 4), 'x')
            }
            return ''
          }).join('\n')
          return `${block.tool_use_id}\n${inner}`
        }
        if (block.type === 'text') {
          return block.text
        }
        // image / document blocks: estimate by base64 payload size, since
        // patch-grid token cost on the provider side is roughly bounded by
        // raw bytes / 4 for vision and ~per-page for documents. Simple
        // heuristic — actual provider tokenization runs server-side.
        if (block.type === 'image' || block.type === 'document') {
          return ''.padEnd(Math.floor(block.source.data.length / 4), 'x')
        }
        return ''
      })
      .join('\n')
    return estimateTokens(userBlockText) + 4
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