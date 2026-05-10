import type { LightClawConfig } from '../config.js'
import type { Tool } from '../tool.js'
import { shouldEnableDeferredLoading } from './deferred-policy.js'
import { isDeferredTool, partitionTools } from './is-deferred.js'
import { toolSearchTool } from './tool-search.js'

export type TurnToolCatalog = {
  tools: Tool[]
  deferred: Tool[]
  deferredEnabled: boolean
}

export function buildTurnToolCatalog(input: {
  allTools: readonly Tool[]
  discoveredTools: ReadonlySet<string>
  config: LightClawConfig
}): TurnToolCatalog {
  const { allTools, discoveredTools, config } = input
  if (!shouldEnableDeferredLoading(config, allTools)) {
    return {
      tools: [...allTools],
      deferred: [],
      deferredEnabled: false,
    }
  }

  const { alwaysLoaded, deferred } = partitionTools(allTools)
  const discovered = deferred.filter(tool => discoveredTools.has(tool.name))
  const tools = [...alwaysLoaded, toolSearchTool, ...discovered]
  return {
    tools: dedupeTools(tools),
    deferred,
    deferredEnabled: true,
  }
}

export function getUndiscoveredDeferredTools(
  deferred: readonly Tool[],
  discoveredTools: ReadonlySet<string>,
): Tool[] {
  return deferred.filter(tool => !discoveredTools.has(tool.name))
}

export function findDeferredTool(
  allTools: readonly Tool[],
  name: string,
): Tool | undefined {
  const tool = allTools.find(item => item.name === name)
  return tool && isDeferredTool(tool) ? tool : undefined
}

function dedupeTools(tools: readonly Tool[]): Tool[] {
  const seen = new Set<string>()
  const out: Tool[] = []
  for (const tool of tools) {
    if (seen.has(tool.name)) continue
    seen.add(tool.name)
    out.push(tool)
  }
  return out
}
