import { flushBeforeCompact } from '../../memory/extract.js'
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
  setLastExtractedAt,
} from '../../state.js'
import { estimateMessagesTokens } from '../../token-estimate.js'
import type { Hook, HookContext } from './types.js'

export const autoCompactHook: Hook = {
  name: 'auto-compact',
  async beforeTurn(ctx) {
    if (!ctx.rolePolicy.contextPolicy.autoCompact) {
      return
    }
    try {
      const mc = await maybeIdleMicroCompact(ctx.messages, ctx.config)
      if (mc.cleared > 0) {
        console.log(
          `[micro-compact:idle] cleared ${mc.cleared} tool_result(s), `
          + `~${mc.tokensSaved} tokens saved `
          + `(gap > ${ctx.config.microCompact.idle.gapThresholdMinutes}min, `
          + `kept last ${ctx.config.microCompact.idle.keepRecent})`,
        )
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[micro-compact:idle] failed: ${msg}`)
    }
  },
  async afterEndTurn(ctx) {
    await runCompaction(ctx, false)
  },
}

export async function runCompaction(
  ctx: HookContext,
  force: boolean,
): Promise<boolean> {
  if (!ctx.rolePolicy.contextPolicy.autoCompact || !ctx.config.autoCompact) {
    return false
  }

  if (!force) {
    const totalTokens = estimateMessagesTokens(ctx.messages)
    const threshold = ctx.config.contextWindow * ctx.config.compactThresholdRatio
    if (totalTokens <= threshold) {
      return false
    }
  }

  if (ctx.config.autoMemory && ctx.config.preCompactFlush.enabled) {
    const flushed = await flushBeforeCompact({
      messages: [...ctx.messages],
      lastExtractedAt: getLastExtractedAt(),
      memoryDir: getMemoryDir(),
      canonicalUser: getCurrentUserId(),
      config: ctx.config,
      ownerRole: ctx.role,
      timeoutMs: ctx.config.preCompactFlush.timeoutMs,
    })
    if (flushed.lastExtractedAt > getLastExtractedAt()) {
      setLastExtractedAt(flushed.lastExtractedAt)
      await updateMetaLastExtractedAt(getSessionId(), flushed.lastExtractedAt)
    }
  }

  ctx.invocation.onCompactStart?.()
  try {
    const result = await compactConversation({
      messages: ctx.messages,
      keepRecent: ctx.config.compactKeepRecent,
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
        keepRecent: Math.max(2, ctx.config.compactKeepRecent * 2),
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
