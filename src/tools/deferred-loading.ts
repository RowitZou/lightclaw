import type { LightClawConfig } from '../config.js'
import type { Tool } from '../tool.js'
import { shouldEnableDeferredLoading } from './deferred-policy.js'
import { isDeferredTool, partitionTools } from './is-deferred.js'
import { toolSearchTool } from './tool-search.js'

export type TurnToolCatalog = {
  tools: Tool[]
  deferred: Tool[]
  deferredEnabled: boolean
  // 2026-05-26: prompt-cache split. `inlineTools` is the always-loaded subset
  // (alwaysLoad-tagged + ToolSearch when deferred loading is on); its
  // membership is fixed for the lifetime of one query loop, so rendering it
  // into the `## Tool Catalog` stable section keeps that section byte-stable.
  // `discoveredCatalogTools` is the this-turn promoted-via-ToolSearch subset;
  // its membership changes between turns, so the prompt renders it inside the
  // variable suffix (injected into the last user message) instead of the
  // stable system section. Both are still in `tools` so the provider's tools
  // array carries every callable schema this turn.
  inlineTools: Tool[]
  discoveredCatalogTools: Tool[]
}

export function buildTurnToolCatalog(input: {
  allTools: readonly Tool[]
  discoveredTools: ReadonlyMap<string, number>
  config: LightClawConfig
}): TurnToolCatalog {
  const { allTools, discoveredTools, config } = input
  if (!shouldEnableDeferredLoading(config, allTools)) {
    const all = [...allTools]
    return {
      tools: all,
      deferred: [],
      deferredEnabled: false,
      inlineTools: all,
      discoveredCatalogTools: [],
    }
  }

  const { alwaysLoaded, deferred } = partitionTools(allTools)
  const discovered = deferred.filter(tool => discoveredTools.has(tool.name))
  const inlineTools = dedupeTools([...alwaysLoaded, toolSearchTool])
  const tools = dedupeTools([...inlineTools, ...discovered])
  return {
    tools,
    deferred,
    deferredEnabled: true,
    inlineTools,
    discoveredCatalogTools: discovered,
  }
}

export function getUndiscoveredDeferredTools(
  deferred: readonly Tool[],
  discoveredTools: ReadonlyMap<string, number>,
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
