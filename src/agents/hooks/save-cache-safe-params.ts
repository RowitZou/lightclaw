import {
  createCacheSafeParams,
  saveCacheSafeParams,
} from '../cache-safe-params.js'
import { getCurrentUserId } from '../../state.js'
import type { Hook } from './types.js'

export const saveCacheSafeParamsHook: Hook = {
  name: 'save-cache-safe-params',
  afterAssistantMessage(ctx) {
    if (ctx.rolePolicy.kind !== 'orchestrator' || ctx.invocation.ephemeral) {
      return
    }

    saveCacheSafeParams(
      getCurrentUserId(),
      createCacheSafeParams({
        systemPrompt: ctx.systemPrompt.renderEffective(),
        tools: ctx.turnCatalog.tools,
        messages: [...ctx.messages],
        config: ctx.config,
      }),
    )
  },
}
