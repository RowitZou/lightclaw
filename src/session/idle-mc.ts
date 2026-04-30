import type { LightClawConfig } from '../config.js'
import { getSessionId, incrementIdleMicroCompactCount } from '../state.js'
import { estimateTokens } from '../token-estimate.js'
import type {
  AssistantContentBlock,
  Message,
  UserToolResultBlock,
} from '../types.js'

import { rewriteTranscript } from './storage.js'

export const CLEARED_MARKER = '[Old tool result content cleared]'

// Mirrors Claude Code COMPACTABLE_TOOLS in
// claude-code-main/src/services/compact/microCompact.ts. Edit/Write are
// included even though their results are short — keeps Claude Code parity
// and avoids special-casing the tool list.
const COMPACTABLE_TOOLS = new Set<string>([
  'Read',
  'Bash',
  'Grep',
  'Glob',
  'WebSearch',
  'WebFetch',
  'Edit',
  'Write',
])

export type IdleMcResult = {
  cleared: number
  tokensSaved: number
}

/**
 * Time-based ("idle") micro-compact, mirroring Claude Code's
 * `maybeTimeBasedMicrocompact`. When the gap since the last main-loop
 * assistant message exceeds the configured threshold, content-clear all but
 * the most recent K compactable tool_results in-place + persist via the
 * existing rewriteTranscript path.
 *
 * Idempotent: re-running on already-cleared content is a no-op.
 *
 * Caller is responsible for skipping subagent mode (see query.ts) — the
 * function does not assume a query mode.
 */
export async function maybeIdleMicroCompact(
  messages: Message[],
  config: LightClawConfig,
): Promise<IdleMcResult> {
  if (!config.microCompact.enabled) return { cleared: 0, tokensSaved: 0 }
  if (!config.microCompact.idle.enabled) return { cleared: 0, tokensSaved: 0 }

  const lastAssistant = findLast(messages, m => m.type === 'assistant')
  if (!lastAssistant) return { cleared: 0, tokensSaved: 0 }

  const gapMs = Date.now() - lastAssistant.timestamp
  const thresholdMs = config.microCompact.idle.gapThresholdMinutes * 60_000
  if (!Number.isFinite(gapMs) || gapMs < thresholdMs) {
    return { cleared: 0, tokensSaved: 0 }
  }

  const compactableIds: string[] = []
  for (const message of messages) {
    if (message.type !== 'assistant') continue
    const content = message.message.content
    if (!Array.isArray(content)) continue
    for (const block of content as AssistantContentBlock[]) {
      if (block.type === 'tool_use' && COMPACTABLE_TOOLS.has(block.name)) {
        compactableIds.push(block.id)
      }
    }
  }

  const keepRecent = Math.max(1, config.microCompact.idle.keepRecent)
  const keepSet = new Set(compactableIds.slice(-keepRecent))
  const clearSet = new Set(compactableIds.filter(id => !keepSet.has(id)))

  if (clearSet.size === 0) return { cleared: 0, tokensSaved: 0 }

  let cleared = 0
  let tokensSaved = 0
  for (const message of messages) {
    if (message.type !== 'user') continue
    const content = message.message.content
    if (!Array.isArray(content)) continue
    for (const block of content as UserToolResultBlock[]) {
      if (block.type !== 'tool_result') continue
      if (!clearSet.has(block.tool_use_id)) continue
      if (typeof block.content !== 'string') continue
      if (block.content === CLEARED_MARKER) continue
      tokensSaved += estimateTokens(block.content)
      block.content = CLEARED_MARKER
      cleared += 1
    }
  }

  if (cleared === 0) return { cleared: 0, tokensSaved: 0 }

  try {
    await rewriteTranscript(getSessionId(), messages)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[micro-compact:idle] rewriteTranscript failed: ${msg}`)
  }

  incrementIdleMicroCompactCount()
  return { cleared, tokensSaved }
}

function findLast<T>(arr: T[], pred: (item: T) => boolean): T | undefined {
  for (let i = arr.length - 1; i >= 0; i -= 1) {
    if (pred(arr[i])) return arr[i]
  }
  return undefined
}
