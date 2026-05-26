import { getCurrentSessionContext } from '../../session-context.js'
import { buildTurnToolCatalog } from '../../tools/deferred-loading.js'
import { pruneStaleDiscoveredTools } from '../../tools/discovered-tools.js'
import type { Hook } from './types.js'

export const deferredToolsHook: Hook = {
  name: 'deferred-tools-discovery',
  beforeTurn(ctx) {
    const sessionCtx = getCurrentSessionContext()
    if (sessionCtx && !ctx.systemPrompt.hasOverride) {
      sessionCtx.turnCounter += 1
      pruneStaleDiscoveredTools(
        sessionCtx.discoveredTools,
        sessionCtx.turnCounter,
        ctx.config.tools.catalog.discoveredToolsTtlTurns,
      )
    }

    if (ctx.systemPrompt.hasOverride) {
      // Custom systemPrompt path: every tool ships inline in the catalog,
      // there is no ToolSearch split. Mirror that into the prompt-cache
      // fields so downstream renderers see a self-consistent shape.
      ctx.setTurnCatalog({
        tools: ctx.allTools,
        deferred: [],
        deferredEnabled: false,
        inlineTools: ctx.allTools,
        discoveredCatalogTools: [],
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
