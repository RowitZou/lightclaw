import { getCurrentSessionContext } from '../../session-context.js'
import { getCurrentEnabledSecrets, getTodos } from '../../state.js'
import { renderSystemPromptSplit } from '../../prompt.js'
import type { Hook } from './types.js'

export const splitRenderHook: Hook = {
  name: 'split-render',
  beforeStream(ctx) {
    if (ctx.systemPrompt.hasOverride) {
      return {
        system: ctx.systemPrompt.hasOverride
          ? (ctx.systemPrompt.override ?? '')
          : ctx.systemPrompt.renderEffective(),
      }
    }

    if (!ctx.systemPrompt.template) {
      return { system: ctx.systemPrompt.renderEffective() }
    }

    const sessionCtx = getCurrentSessionContext()
    const rendered = renderSystemPromptSplit(ctx.systemPrompt.template, getTodos(), {
      tools: ctx.turnCatalog.tools,
      // 2026-05-26 cache anchoring: render only the always-loaded subset into
      // the stable `## Tool Catalog`; route already-discovered deferred tools
      // through the variable suffix so promoting a new tool via ToolSearch no
      // longer extends the stable system prompt and breaks OpenAI prefix-cache.
      inlineCatalogTools: ctx.turnCatalog.inlineTools,
      discoveredCatalogTools: ctx.turnCatalog.discoveredCatalogTools,
      deferredTools: ctx.turnCatalog.deferred,
      discoveredTools: sessionCtx?.discoveredTools,
      enabledSecrets: getCurrentEnabledSecrets(),
    })
    return {
      system: ctx.invocation.channelContext
        ? `${ctx.invocation.channelContext}\n\n${rendered.stable}`
        : rendered.stable,
      systemVariableSuffix: rendered.variable || undefined,
    }
  },
}
