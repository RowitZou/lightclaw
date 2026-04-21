export type UsageStats = {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

export type AssistantTextBlock = {
  type: 'text'
  text: string
}

export type AssistantToolUseBlock = {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export type AssistantContentBlock =
  | AssistantTextBlock
  | AssistantToolUseBlock

export type UserToolResultBlock = {
  type: 'tool_result'
  tool_use_id: string
  content: string
  is_error?: boolean
}

export type UserMessage = {
  type: 'user'
  uuid: string
  parentUuid: string | null
  timestamp: number
  message: {
    role: 'user'
    content: string | UserToolResultBlock[]
  }
}

export type AssistantMessage = {
  type: 'assistant'
  uuid: string
  parentUuid: string | null
  timestamp: number
  message: {
    role: 'assistant'
    content: AssistantContentBlock[]
    stop_reason: string | null
    usage: UsageStats
  }
}

export type SystemCompactMessage = {
  type: 'system'
  uuid: string
  parentUuid: string | null
  timestamp: number
  message: {
    content: 'compact_boundary'
    summary: string
  }
}

export type Message = UserMessage | AssistantMessage | SystemCompactMessage

export type SessionMeta = {
  sessionId: string
  model: string
  cwd: string
  createdAt: number
  lastActiveAt: number
  messageCount: number
  compactionCount: number
  lastExtractedAt?: number
  todos?: TodoItem[]
}

export type StreamTextEvent = {
  type: 'text'
  text: string
}

export type StreamToolUseEvent = {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
  index: number
}

export type StreamStopEvent = {
  type: 'stop'
  stopReason: string | null
  usage: UsageStats
  content: AssistantContentBlock[]
}

export type StreamEvent =
  | StreamTextEvent
  | StreamToolUseEvent
  | StreamStopEvent

export type ToolExecutionEvent = {
  toolName: string
  isError: boolean
  content: string
}

export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export type TodoItem = {
  content: string
  activeForm: string
  status: TodoStatus
}

export type { MemoryEntry, MemoryFrontmatter, MemoryType } from './memory/types.js'
export type { Provider, ProviderCapabilities, ProviderName } from './provider/types.js'
export type { LoadedSkill, SkillMeta, SkillSource } from './skill/types.js'
