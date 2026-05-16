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
      !ctx.rolePolicy.contextPolicy.autoMemoryExtract
      || ctx.stopReason() !== 'end_turn'
      || ctx.invocation.ephemeral
      || !ctx.config.autoMemory
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

    if (!ctx.config.autoDream.enabled) {
      return
    }
    const userId = getCurrentUserId()
    if (!userId) {
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
