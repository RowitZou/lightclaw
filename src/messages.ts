import { randomUUID } from 'node:crypto'

import type {
  AssistantContentBlock,
  AssistantMessage,
  Message,
  SystemCompactMessage,
  UsageStats,
  UserContentBlock,
  UserMessage,
} from './types.js'

export function createUserMessage(
  content: string | UserContentBlock[],
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

export type WireMessage = {
  role: 'user' | 'assistant'
  content: unknown
}

export function toApiMessages(messages: Message[]): WireMessage[] {
  return messages.map(message => {
    if (message.type === 'system') {
      // The continuation header is already baked into the summary by
      // formatCompactBoundaryText (compact.ts); adding a wire-side
      // "Previous conversation summary:" prefix here duplicates it.
      return {
        role: 'user',
        content: message.message.summary,
      }
    }

    return {
      role: message.message.role,
      content: message.message.content,
    }
  })
}

// The per-turn volatile suffix (TodoList + deferred-tools reminder) used to
// be concatenated onto the system prompt and shipped as part of
// `instructions` (OpenAI) / a second system block without cache_control
// (Anthropic). On OpenAI Codex this broke auto prefix-cache: the wire
// fingerprint diverges at the first variable byte, and the entire `input`
// array that follows misses cache — 2026-05-26 dogfood showed ~1.5K of
// cache hit on 25–90K input turns, where TTFB-retry of an identical
// request hit ~37K cache the moment the same prefix was re-submitted.
// Moving the suffix into the last user message keeps the system prompt
// purely stable (fully cacheable across turns) and pushes the volatile
// part into a position where the cache miss was happening anyway (the
// fresh tool_result block at the end of input). Equivalent improvement
// on Anthropic via removal of the second uncached system block.
export function injectSystemReminderIntoLastUserMessage(
  messages: WireMessage[],
  reminder: string,
): WireMessage[] {
  if (!reminder || reminder.length === 0) return messages
  let lastUserIndex = -1
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') {
      lastUserIndex = i
      break
    }
  }
  if (lastUserIndex === -1) return messages

  const reminderBlock = { type: 'text' as const, text: reminder }
  return messages.map((m, i) => {
    if (i !== lastUserIndex) return m
    const original = m.content
    if (typeof original === 'string') {
      return {
        role: m.role,
        content: [{ type: 'text' as const, text: original }, reminderBlock],
      }
    }
    if (Array.isArray(original)) {
      return {
        role: m.role,
        content: [...original, reminderBlock],
      }
    }
    // Defensive: unknown shape (should not happen post-toApiMessages).
    // Leave untouched rather than corrupt the wire payload.
    return m
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