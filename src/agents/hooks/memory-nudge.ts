import { buildMemoryNudgeBlock, isMemoryNudgeDue } from '../../memory/nudge.js'
import { getCurrentSessionContext } from '../../session-context.js'
import type { UserContentBlock } from '../../types.js'
import type { Hook } from './types.js'

export const memoryNudgeHook: Hook = {
  name: 'memory-nudge',
  atToolBoundary(ctx) {
    const sessionCtx = getCurrentSessionContext()
    if (
      !sessionCtx
      || ctx.rolePolicy.kind === 'internal'
      || ctx.systemPrompt.hasOverride
      || ctx.invocation.ephemeral
      || ctx.invocation.noAutoMemory
      || !ctx.config.memory.extractor.enabled
      || !ctx.config.memory.nudge.enabled
      || !isMemoryNudgeDue(
        sessionCtx.turnCounter,
        sessionCtx.lastMemoryNudgeTurn,
        ctx.config.memory.nudge.everyTurns,
      )
    ) {
      return []
    }

    sessionCtx.lastMemoryNudgeTurn = sessionCtx.turnCounter
    process.stderr.write(
      `query: injected memory nudge at turn ${sessionCtx.turnCounter}\n`,
    )
    return [{ type: 'text', text: buildMemoryNudgeBlock() } satisfies UserContentBlock]
  },
}
