import { executeAutoDream } from '../../memory/dream/dream.js'
import { extractMemories } from '../../memory/extract.js'
import {
  getCurrentUserId,
  getLastExtractedAt,
  getMemoryDir,
  getSessionId,
  registerBackgroundTask,
  setLastExtractedAt,
} from '../../state.js'
import { updateMetaLastExtractedAt } from '../../session/storage.js'
import type { Hook } from './types.js'

export const autoMemoryHook: Hook = {
  name: 'auto-memory-extract',
  afterEndTurn(ctx) {
    if (
      ctx.rolePolicy.kind === 'internal'
      || ctx.stopReason() !== 'end_turn'
      || ctx.invocation.ephemeral
      || !ctx.config.memory.extractor.enabled
    ) {
      return
    }

    const snapshot = ctx.messagesSnapshot ?? [...ctx.messages]
    const lastExtractedAt = getLastExtractedAt()
    const task = extractMemories({
      messages: snapshot,
      lastExtractedAt,
      memoryDir: getMemoryDir(),
      canonicalUser: getCurrentUserId(),
      config: ctx.config,
      ownerRole: ctx.role,
    })
      .then(async result => {
        if (result.lastExtractedAt <= lastExtractedAt) {
          return
        }

        setLastExtractedAt(result.lastExtractedAt)
        await updateMetaLastExtractedAt(getSessionId(), result.lastExtractedAt)
      })
      .catch(error => {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[memory] ${message}`)
      })

    registerBackgroundTask(task)

    if (!ctx.config.memory.curator.enabled) {
      // PR2 diagnostic (2026-05-27): the dream hook silently bails on
      // curator-disabled and userId-null. Tracing these turns the "first
      // autoDream took 11h" attribution from guesswork into a grep.
      console.error('[auto-dream] gated user=<none> reason=curator-disabled pending=hook')
      return
    }
    const userId = getCurrentUserId()
    if (!userId) {
      console.error('[auto-dream] gated user=<none> reason=userId-null pending=hook')
      return
    }

    const dreamTask = executeAutoDream({
      userId,
      memoryDir: getMemoryDir(),
      config: ctx.config,
      currentSessionId: getSessionId(),
    }).catch(error => {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[auto-dream] ${message}`)
    })

    registerBackgroundTask(dreamTask)
  },
}
