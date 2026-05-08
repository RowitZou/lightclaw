import {
  createSystemCompactMessage,
  getLastUuid,
} from '../messages.js'
import type { Message } from '../types.js'

/**
 * Hard-truncation fallback used when LLM-based summarization fails on the
 * reactive prompt-too-long recovery path. Keeps the most recent messages,
 * elides the prefix, and prepends a synthetic compact_boundary summary so
 * the model sees a coherent transcript and the user is never stuck on
 * "compact failed".
 *
 * Boundary safety: a kept window can't start mid-tool-loop (a `user`
 * message whose content is a tool_result block has no matching tool_use
 * once the prefix is gone — Anthropic rejects that with a 400). Walk
 * forward from the candidate split until we hit a fresh user turn (string
 * content or text-only blocks). If no such boundary exists in the keep
 * window, return the original messages unchanged so the caller can
 * surface the original prompt-too-long error rather than corrupt the
 * transcript with an invalid slice.
 */
export type CompactFallbackResult = {
  messages: Message[]
  removedCount: number
}

export function compactFallbackTruncate(
  messages: Message[],
  options: { keepRecent: number; reason: string },
): CompactFallbackResult {
  const keep = Math.max(2, options.keepRecent)
  if (messages.length <= keep) {
    return { messages: [...messages], removedCount: 0 }
  }

  const candidate = messages.length - keep
  let splitIdx = candidate
  while (splitIdx < messages.length && !isFreshUserTurn(messages[splitIdx]!)) {
    splitIdx += 1
  }
  if (splitIdx >= messages.length) {
    return { messages: [...messages], removedCount: 0 }
  }

  const elided = messages.slice(0, splitIdx)
  const kept = messages.slice(splitIdx)
  const summary = buildFallbackSummary({
    elidedCount: elided.length,
    reason: options.reason,
  })
  const boundary = createSystemCompactMessage({
    summary,
    parentUuid: getLastUuid(elided),
  })

  return {
    messages: [
      boundary,
      withParentUuid(kept[0]!, boundary.uuid),
      ...kept.slice(1),
    ],
    removedCount: elided.length,
  }
}

function isFreshUserTurn(message: Message): boolean {
  if (message.type !== 'user') return false
  const content = message.message.content
  if (typeof content === 'string') return true
  if (!Array.isArray(content)) return false
  return content.length > 0 && content.every(block => block.type === 'text')
}

function withParentUuid(message: Message, parentUuid: string | null): Message {
  return { ...message, parentUuid }
}

function buildFallbackSummary(input: {
  elidedCount: number
  reason: string
}): string {
  return [
    '## Compact Fallback (LLM summarization failed)',
    '',
    `The earlier conversation prefix (${input.elidedCount} message${input.elidedCount === 1 ? '' : 's'}) was elided as a hard-truncation fallback because the summarization model could not produce a summary.`,
    '',
    `Reason: ${input.reason}`,
    '',
    'If specific earlier context is needed to answer the next user message, ask the user to restate the relevant facts.',
  ].join('\n')
}
