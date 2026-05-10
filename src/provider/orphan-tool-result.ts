import type { UserToolResultBlock } from '../types.js'
import type { ApiMessage } from './types.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Defense-in-depth filter for OpenAI-schema providers.
 *
 * OpenAI Chat Completions and the Responses API both 400 when the input
 * contains a tool message / function_call_output whose `tool_call_id` /
 * `call_id` does not match a preceding tool_calls / function_call item.
 * Anthropic Messages API is lenient about this, so an Anthropic-shaped
 * transcript that loses an assistant `tool_use` (e.g. mid-pair compaction
 * before the fix in `compact.ts:findSafeSplitIndex`, or a manual import)
 * silently breaks only on the OpenAI side.
 *
 * This filter scans the message list once, accumulates every assistant
 * `tool_use.id`, and drops `user.tool_result` blocks whose `tool_use_id`
 * is not in the accumulated set. If a user message had only orphan
 * tool_result blocks, the message itself is dropped. Any drop is logged
 * to stderr so the provenance is visible during dogfood.
 */
export function dropOrphanToolResults(messages: ApiMessage[]): ApiMessage[] {
  const seenToolUseIds = new Set<string>()
  const out: ApiMessage[] = []
  let droppedBlocks = 0
  let droppedMessages = 0

  for (const message of messages) {
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (
          isRecord(block) &&
          block.type === 'tool_use' &&
          typeof block.id === 'string'
        ) {
          seenToolUseIds.add(block.id)
        }
      }
      out.push(message)
      continue
    }

    if (message.role === 'user' && Array.isArray(message.content)) {
      const filtered = message.content.filter(block => {
        if (!isRecord(block)) return true
        if (block.type !== 'tool_result') return true
        const tuId = (block as UserToolResultBlock).tool_use_id
        if (typeof tuId === 'string' && seenToolUseIds.has(tuId)) return true
        droppedBlocks++
        return false
      })

      if (filtered.length === 0 && message.content.length > 0) {
        droppedMessages++
        continue
      }

      if (filtered.length === message.content.length) {
        out.push(message)
      } else {
        out.push({ ...message, content: filtered })
      }
      continue
    }

    out.push(message)
  }

  if (droppedBlocks > 0 || droppedMessages > 0) {
    process.stderr.write(
      `[provider] dropped ${droppedBlocks} orphan tool_result block(s)` +
        ` and ${droppedMessages} now-empty user message(s) before request\n`,
    )
  }

  return out
}
