import {
  cancelDispatchTool,
  dispatchTool,
  listDispatchesTool,
  updateDispatchTool,
} from './tools/dispatch.js'
import { askUserQuestionTool } from './tools/ask-user-question.js'
import { notifyTool } from './tools/notify.js'
import { bashTool } from './tools/bash.js'
import { killBashTool } from './tools/kill-bash.js'
import { conversationGrepTool } from './tools/conversation-grep.js'
import { conversationListTool } from './tools/conversation-list.js'
import { conversationReadTool } from './tools/conversation-read.js'
import { fileEditTool } from './tools/file-edit.js'
import { fileReadTool } from './tools/file-read.js'
import { fileWriteTool } from './tools/file-write.js'
import {
  feishuCreateFileTool,
  feishuReadTool,
  feishuWriteDocTool,
  feishuWriteSheetTool,
} from './tools/feishu-collab.js'
import {
  feishuCreateFolderTool,
  feishuDeleteTool,
  feishuListTool,
  feishuMoveTool,
} from './tools/feishu-workspace.js'
import { globTool } from './tools/glob.js'
import { grepTool } from './tools/grep.js'
import { memoryReadTool } from './tools/memory-read.js'
import { memoryDeleteTool } from './tools/memory-delete.js'
import { memoryMoveTool } from './tools/memory-move.js'
import { memoryWriteAtTool } from './tools/memory-write-at.js'
import { memoryWriteTool } from './tools/memory-write.js'
import { sendFileTool } from './tools/send-file.js'
import { skillWriteTool } from './tools/skill-write.js'
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
  killBashTool,
  conversationListTool,
  conversationReadTool,
  conversationGrepTool,
  fileReadTool,
  feishuReadTool,
  feishuListTool,
  feishuCreateFileTool,
  feishuCreateFolderTool,
  feishuMoveTool,
  feishuDeleteTool,
  feishuWriteDocTool,
  feishuWriteSheetTool,
  fileWriteTool,
  fileEditTool,
  grepTool,
  globTool,
  memoryReadTool,
  memoryWriteAtTool,
  memoryMoveTool,
  memoryDeleteTool,
  memoryWriteTool,
  sendFileTool,
  skillWriteTool,
  sleepTool,
  useSkillTool,
  todoWriteTool,
  webFetchTool,
  webSearchTool,
  dispatchTool,
  listDispatchesTool,
  cancelDispatchTool,
  updateDispatchTool,
  notifyTool,
  askUserQuestionTool,
]

export function getAllTools(
  channel?: ChannelKey,
  options?: { includeInternal?: boolean },
): Tool[] {
  const all = [...builtinTools, ...getMcpTools()]
  return all.filter(tool =>
    (options?.includeInternal || !tool.internalOnly) &&
    (!tool.channelOnly || channel !== undefined) &&
    (!channel || isToolVisibleInChannel(tool, channel)),
  )
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
