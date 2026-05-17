import { getCurrentSessionContext } from '../../session-context.js'
import { getTodos } from '../../state.js'
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
      deferredTools: ctx.turnCatalog.deferred,
      discoveredTools: sessionCtx?.discoveredTools,
    })
    return {
      system: ctx.invocation.channelContext
        ? `${ctx.invocation.channelContext}\n\n${rendered.stable}`
        : rendered.stable,
      systemVariableSuffix: rendered.variable || undefined,
    }
  },
}
