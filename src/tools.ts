import { agentTool } from './tools/agent.js'
import { bashTool } from './tools/bash.js'
import { fileEditTool } from './tools/file-edit.js'
import { fileReadTool } from './tools/file-read.js'
import { fileWriteTool } from './tools/file-write.js'
import { globTool } from './tools/glob.js'
import { grepTool } from './tools/grep.js'
import { memoryReadTool } from './tools/memory-read.js'
import { memoryWriteTool } from './tools/memory-write.js'
import { todoWriteTool } from './tools/todo-write.js'
import { useSkillTool } from './tools/use-skill.js'
import { webFetchTool } from './tools/web-fetch.js'
import { webSearchTool } from './tools/web-search.js'
import { getMcpTools } from './mcp/index.js'
import type { Provider } from './provider/types.js'
import type { Tool } from './tool.js'

export const builtinTools = [
  bashTool,
  fileReadTool,
  fileWriteTool,
  fileEditTool,
  grepTool,
  globTool,
  memoryReadTool,
  memoryWriteTool,
  useSkillTool,
  todoWriteTool,
  webFetchTool,
  webSearchTool,
  agentTool,
]

export const allTools = builtinTools

export function getAllTools(): Tool[] {
  return [...builtinTools, ...getMcpTools()]
}

export function getEnabledTools(
  provider: Provider,
  tools: Tool[] = getAllTools(),
): Tool[] {
  return tools.filter(tool => tool.isEnabled?.(provider) ?? true)
}
