import { getCurrentSessionContext } from '../../session-context.js'
import { buildTurnToolCatalog } from '../../tools/deferred-loading.js'
import { pruneStaleDiscoveredTools } from '../../tools/discovered-tools.js'
import type { Hook } from './types.js'

export const deferredToolsHook: Hook = {
  name: 'deferred-tools-discovery',
  beforeTurn(ctx) {
    const sessionCtx = getCurrentSessionContext()
    if (
      sessionCtx
      && ctx.rolePolicy.contextPolicy.deferredToolDiscovery
      && !ctx.systemPrompt.hasOverride
    ) {
      sessionCtx.turnCounter += 1
      pruneStaleDiscoveredTools(
        sessionCtx.discoveredTools,
        sessionCtx.turnCounter,
        ctx.config.tools.discoveredToolsTtlTurns,
      )
    }

    if (!ctx.rolePolicy.contextPolicy.cacheStable || ctx.systemPrompt.hasOverride) {
      ctx.setTurnCatalog({
        tools: ctx.allTools,
        deferred: [],
        deferredEnabled: false,
      })
      return
    }

    ctx.setTurnCatalog(buildTurnToolCatalog({
      allTools: ctx.allTools,
      discoveredTools: sessionCtx?.discoveredTools ?? new Map(),
      config: ctx.config,
    }))
  },
}
