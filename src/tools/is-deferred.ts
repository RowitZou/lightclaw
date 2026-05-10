import type { Tool } from '../tool.js'

export function isDeferredTool(tool: Tool): boolean {
  if (tool.shouldDefer === true) return true
  if (tool.alwaysLoad === true) return false
  if (tool.name === 'ToolSearch') return false
  return tool.source === 'mcp'
}

export function partitionTools(
  tools: readonly Tool[],
): { alwaysLoaded: Tool[]; deferred: Tool[] } {
  const alwaysLoaded: Tool[] = []
  const deferred: Tool[] = []
  for (const tool of tools) {
    if (isDeferredTool(tool)) {
      deferred.push(tool)
    } else {
      alwaysLoaded.push(tool)
    }
  }
  return { alwaysLoaded, deferred }
}
