import { agentTool } from './tools/agent.js'
import {
  backgroundTaskTool,
  cancelBackgroundTaskTool,
  listBackgroundTasksTool,
  updateBackgroundTaskTool,
} from './tools/background-task.js'
import { bashTool } from './tools/bash.js'
import { conversationGrepTool } from './tools/conversation-grep.js'
import { conversationListTool } from './tools/conversation-list.js'
import { conversationReadTool } from './tools/conversation-read.js'
import { fileEditTool } from './tools/file-edit.js'
import { fileReadTool } from './tools/file-read.js'
import { fileWriteTool } from './tools/file-write.js'
import { feishuReadTool } from './tools/feishu-collab.js'
import { globTool } from './tools/glob.js'
import { grepTool } from './tools/grep.js'
import { memoryReadTool } from './tools/memory-read.js'
import { memoryWriteTool } from './tools/memory-write.js'
import { sendFileTool } from './tools/send-file.js'
import { sleepTool } from './tools/sleep.js'
import { todoWriteTool } from './tools/todo-write.js'
import { useSkillTool } from './tools/use-skill.js'
import { webFetchTool } from './tools/web-fetch.js'
import { webSearchTool } from './tools/web-search.js'
import { getMcpTools } from './mcp/index.js'
import type { Provider } from './provider/types.js'
import type { Tool } from './tool.js'
import type { ChannelKey } from './channel-types.js'

export const builtinTools = [
  bashTool,
  conversationListTool,
  conversationReadTool,
  conversationGrepTool,
  fileReadTool,
  feishuReadTool,
  fileWriteTool,
  fileEditTool,
  grepTool,
  globTool,
  memoryReadTool,
  memoryWriteTool,
  sendFileTool,
  sleepTool,
  useSkillTool,
  todoWriteTool,
  webFetchTool,
  webSearchTool,
  agentTool,
  backgroundTaskTool,
  listBackgroundTasksTool,
  cancelBackgroundTaskTool,
  updateBackgroundTaskTool,
]

export function getAllTools(channel?: ChannelKey): Tool[] {
  const all = [...builtinTools, ...getMcpTools()]
  if (!channel) {
    return all
  }
  return all.filter(tool => isToolVisibleInChannel(tool, channel))
}

export function isToolVisibleInChannel(tool: Tool, channel: ChannelKey): boolean {
  return tool.channelScope === undefined || tool.channelScope.includes(channel)
}

export function getEnabledTools(
  provider: Provider,
  tools: Tool[] = getAllTools(),
): Tool[] {
  return tools.filter(tool => tool.isEnabled?.(provider) ?? true)
}
