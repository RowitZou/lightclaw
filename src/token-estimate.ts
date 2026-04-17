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

  return estimateTokens(`${block.name}\n${JSON.stringify(block.input)}`)
}

export function estimateMessageTokens(message: Message): number {
  if (message.type === 'system') {
    return estimateTokens(message.message.summary) + 4
  }

  if (message.type === 'user') {
    if (typeof message.message.content === 'string') {
      return estimateTokens(message.message.content) + 4
    }

    const toolResultText = message.message.content
      .map(block => `${block.tool_use_id}\n${block.content}`)
      .join('\n')
    return estimateTokens(toolResultText) + 4
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