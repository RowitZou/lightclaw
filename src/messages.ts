import { randomUUID } from 'node:crypto'

import type {
  AssistantContentBlock,
  AssistantMessage,
  Message,
  UsageStats,
  UserMessage,
  UserToolResultBlock,
} from './types.js'

export function createUserMessage(
  content: string | UserToolResultBlock[],
): UserMessage {
  return {
    type: 'user',
    uuid: randomUUID(),
    message: {
      role: 'user',
      content,
    },
  }
}

export function createAssistantMessage(input: {
  content: AssistantContentBlock[]
  stopReason: string | null
  usage: UsageStats
}): AssistantMessage {
  return {
    type: 'assistant',
    uuid: randomUUID(),
    message: {
      role: 'assistant',
      content: input.content,
      stop_reason: input.stopReason,
      usage: input.usage,
    },
  }
}

export function toApiMessages(messages: Message[]): Array<{
  role: 'user' | 'assistant'
  content: unknown
}> {
  return messages.map(message => ({
    role: message.message.role,
    content: message.message.content,
  }))
}

export function collectAssistantText(blocks: AssistantContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<AssistantContentBlock, { type: 'text' }> =>
      block.type === 'text',
    )
    .map(block => block.text)
    .join('')
}