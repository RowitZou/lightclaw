import { extractMemories } from '../../memory/extract.js'
import { compactConversation } from '../../session/compact.js'
import { compactFallbackTruncate } from '../../session/compact-fallback.js'
import { maybeIdleMicroCompact } from '../../session/idle-mc.js'
import { updateMetaLastExtractedAt } from '../../session/storage.js'
import {
  addUsage,
  getCurrentUserId,
  getLastExtractedAt,
  getMemoryDir,
  getSessionId,
  incrementCompactionCount,
  registerBackgroundTask,
  setLastExtractedAt,
} from '../../state.js'
import { estimateProjectedInputTokens } from '../../token-estimate.js'
import type { Hook, HookContext } from './types.js'

// Test seam: the threshold compaction path calls `compactImpl` so tests can
// swap in a synchronous fake and exercise turn-internal compaction without a
// real summary LLM call. Production always uses the real implementation.
let compactImpl: typeof compactConversation = compactConversation

export function setCompactConversationForTest(
  impl: typeof compactConversation | null,
): void {
  compactImpl = impl ?? compactConversation
}

export const autoCompactHook: Hook = {
  name: 'auto-compact',
  async beforeTurn(ctx) {
    try {
      const mc = await maybeIdleMicroCompact(ctx.messages, ctx.config)
      if (mc.cleared > 0) {
        console.log(
          `[micro-compact:idle] cleared ${mc.cleared} tool_result(s), `
          + `~${mc.tokensSaved} tokens saved `
          + `(gap > ${ctx.config.compact.micro.idle.gapThresholdMinutes}min, `
          + `kept last ${ctx.config.compact.micro.idle.keepRecent})`,
        )
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[micro-compact:idle] failed: ${msg}`)
    }
    // Threshold compaction inside the turn loop, not only at afterEndTurn:
    // a turn that runs many tool iterations without ending would otherwise
    // never compact and grow context without bound (5.21 dogfood Bug 5).
    // runCompaction is gated by the token threshold, so this is a cheap
    // no-op until the turn actually grows past it. A compaction failure
    // must not kill the turn — it just proceeds uncompacted.
    try {
      await runCompaction(ctx, false)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[auto-compact:beforeTurn] failed: ${msg}`)
    }
  },
  async afterEndTurn(ctx) {
    await runCompaction(ctx, false)
  },
}

// Pre-compact memory flush: capture the about-to-be-compacted prefix into
// auto-memory before compaction rewrites it away. Fire-and-forget —
// extraction runs on a snapshot copy, so the compaction below cannot lose
// data, and nothing in the turn needs the result synchronously. Do NOT
// re-add a synchronous wait here: the old shape awaited an 8s race that
// real extractions structurally never won (the extractor subagent's first
// token alone has p50 ~6.4s on the system lane — review 2026-07-10 §1.8),
// so every large-session compaction paid the full timeout as dead latency
// and then dropped the raced promise, losing the watermark advance. The
// continuation below is what persists the watermark when the extraction
// eventually lands; without it the next trigger re-analyzes the same
// window (duplicate extractor cost). sessionId is captured at kick time so
// the late meta write can never land under a different ambient context.
function kickPreCompactFlush(ctx: HookContext): void {
  const sessionId = getSessionId()
  const task = extractMemories({
    messages: [...ctx.messages],
    lastExtractedAt: getLastExtractedAt(),
    memoryDir: getMemoryDir(),
    canonicalUser: getCurrentUserId(),
    config: ctx.config,
    ownerRole: ctx.role,
  })
    .then(async result => {
      if (result.lastExtractedAt <= getLastExtractedAt()) {
        return
      }
      setLastExtractedAt(result.lastExtractedAt)
      await updateMetaLastExtractedAt(sessionId, result.lastExtractedAt)
    })
    .catch(error => {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[memory] pre-compact flush failed for ${sessionId}: ${message}`)
    })
  registerBackgroundTask(task)
}

export async function runCompaction(
  ctx: HookContext,
  force: boolean,
): Promise<boolean> {
  if (!ctx.config.compact.auto) {
    return false
  }

  if (!force) {
    // Project the next request's wire-tokens using the most recent
    // assistant.usage.input_tokens as anchor and calibrating any newly
    // appended messages with the same anchor's prefix bias. Falls back to
    // pure local estimate on cold start. Without this, codex /
    // multimodal sessions silently underestimated 1.17-3.68x and the
    // 150K-default threshold never tripped before upstream rejected the
    // request as oversize (2026-05-26 dogfood audit).
    const totalTokens = estimateProjectedInputTokens(ctx.messages)
    const threshold = ctx.config.contextWindow * ctx.config.compact.thresholdRatio
    if (totalTokens <= threshold) {
      return false
    }
  }

  if (ctx.config.memory.extractor.enabled && ctx.config.compact.preFlush.enabled) {
    kickPreCompactFlush(ctx)
  }

  ctx.invocation.onCompactStart?.()
  try {
    const result = await compactImpl({
      messages: ctx.messages,
      keepRecent: ctx.config.compact.keepRecent,
      config: ctx.config,
      sessionId: getSessionId(),
    })

    if (result.removedCount === 0) {
      return false
    }

    ctx.messages.splice(0, ctx.messages.length, ...result.messages)
    addUsage(result.usage)
    ctx.mergeUsage(result.usage)
    incrementCompactionCount()
    ctx.markDidCompact()
    ctx.invocation.onCompactEnd?.({
      removedCount: result.removedCount,
      summaryTokens: result.summaryTokens,
    })
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`[compact] LLM compaction failed (force=${force}): ${message}\n`)
    ctx.invocation.onCompactError?.(message)

    if (force) {
      const fallback = compactFallbackTruncate(ctx.messages, {
        keepRecent: Math.max(2, ctx.config.compact.keepRecent * 2),
        reason: message,
      })
      if (fallback.removedCount > 0) {
        ctx.messages.splice(0, ctx.messages.length, ...fallback.messages)
        incrementCompactionCount()
        ctx.markDidCompact()
        process.stderr.write(
          `[compact] hard-truncate fallback elided ${fallback.removedCount} messages after LLM failure\n`,
        )
        ctx.invocation.onCompactEnd?.({
          removedCount: fallback.removedCount,
          summaryTokens: 0,
        })
        return true
      }
    }
    return false
  }
}
