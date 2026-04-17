import { randomUUID } from 'node:crypto'

import type {
  AssistantContentBlock,
  AssistantMessage,
  Message,
  SystemCompactMessage,
  UsageStats,
  UserMessage,
  UserToolResultBlock,
} from './types.js'

export function createUserMessage(
  content: string | UserToolResultBlock[],
  parentUuid: string | null = null,
  timestamp = Date.now(),
): UserMessage {
  return {
    type: 'user',
    uuid: randomUUID(),
    parentUuid,
    timestamp,
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
  parentUuid?: string | null
  timestamp?: number
}): AssistantMessage {
  return {
    type: 'assistant',
    uuid: randomUUID(),
    parentUuid: input.parentUuid ?? null,
    timestamp: input.timestamp ?? Date.now(),
    message: {
      role: 'assistant',
      content: input.content,
      stop_reason: input.stopReason,
      usage: input.usage,
    },
  }
}

export function createSystemCompactMessage(input: {
  summary: string
  parentUuid: string | null
  timestamp?: number
}): SystemCompactMessage {
  return {
    type: 'system',
    uuid: randomUUID(),
    parentUuid: input.parentUuid,
    timestamp: input.timestamp ?? Date.now(),
    message: {
      content: 'compact_boundary',
      summary: input.summary,
    },
  }
}

export function getLastUuid(messages: Message[]): string | null {
  return messages.length > 0 ? messages[messages.length - 1]?.uuid ?? null : null
}

export function toApiMessages(messages: Message[]): Array<{
  role: 'user' | 'assistant'
  content: unknown
}> {
  return messages.map(message => {
    if (message.type === 'system') {
      return {
        role: 'user',
        content: `Previous conversation summary:\n${message.message.summary}`,
      }
    }

    return {
      role: message.message.role,
      content: message.message.content,
    }
  })
}

export function collectAssistantText(blocks: AssistantContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<AssistantContentBlock, { type: 'text' }> =>
      block.type === 'text',
    )
    .map(block => block.text)
    .join('')
}