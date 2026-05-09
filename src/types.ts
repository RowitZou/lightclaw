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

// Extended-thinking blocks emitted by Claude 4.x reasoning models. The full
// block (including `signature`) MUST be echoed back in subsequent requests
// when the same assistant turn also contains tool_use, otherwise the API
// returns 400 "Improperly formed request" on the next call.
// See https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking
export type AssistantThinkingBlock = {
  type: 'thinking'
  thinking: string
  signature: string
}

// Server-redacted thinking block. We never read the payload — round-trip it
// verbatim to satisfy the same multi-turn signature requirement.
export type AssistantRedactedThinkingBlock = {
  type: 'redacted_thinking'
  data: string
}

export type AssistantContentBlock =
  | AssistantTextBlock
  | AssistantToolUseBlock
  | AssistantThinkingBlock
  | AssistantRedactedThinkingBlock

export type UserToolResultBlock = {
  type: 'tool_result'
  tool_use_id: string
  content: string
  is_error?: boolean
}

// Plain text block inside a user message's content array. Coexists with
// `tool_result` blocks so that one user message can carry both placeholder
// tool_results (synthesized when forking from a parent assistant turn that
// still has pending tool_use blocks) and the fork's own directive text.
// Without this, AgentTool subagents POST a prefix that ends in an assistant
// tool_use whose tool_result must come from the fork itself — which it can't,
// because the fork's own user prompt is a fresh text — and Anthropic rejects
// the request with `messages.<n>: tool_use ids were found without tool_result`.
// Mirrors Claude Code's `buildForkedMessages` (src/tools/AgentTool/forkSubagent.ts)
// which puts placeholder tool_results + the directive in a single user message.
export type UserTextBlock = {
  type: 'text'
  text: string
}

// Inline image / pdf attachments. Encoded base64 directly so the transcript
// snapshot is self-contained — replaying a session does not need the original
// file on disk anymore. Anthropic-style shape (mediaType + base64 data) is
// canonical; per-provider message converters translate to image_url for
// OpenAI Responses, etc.
export type UserImageBlock = {
  type: 'image'
  source: {
    type: 'base64'
    mediaType: string
    data: string
  }
}

export type UserDocumentBlock = {
  type: 'document'
  source: {
    type: 'base64'
    mediaType: string
    data: string
  }
}

export type UserContentBlock =
  | UserToolResultBlock
  | UserTextBlock
  | UserImageBlock
  | UserDocumentBlock

export type UserMessage = {
  type: 'user'
  uuid: string
  parentUuid: string | null
  timestamp: number
  branchSpawn?: BranchSpawnMeta
  origin?: 'bg-task-wake'
  metadata?: {
    interjectionEntries?: Array<{
      messageId: string
      senderOpenId: string
      arrivedAt: number
      text: string
    }>
  }
  message: {
    role: 'user'
    content: string | UserContentBlock[]
  }
}

export type AssistantMessage = {
  type: 'assistant'
  uuid: string
  parentUuid: string | null
  timestamp: number
  branchPlaceholder?: BranchPlaceholderMeta
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

export type BranchSpawnMeta = {
  branchId: string
  branchSessionId: string
}

export type BranchPlaceholderMeta = {
  branchId: string
  branchSessionId: string
  status: 'running' | 'completed' | 'failed' | 'interrupted'
  startedAt: string
  completedAt?: string
}

export type SessionMeta = {
  sessionId: string
  model: string
  cwd: string
  createdAt: number
  lastActiveAt: number
  messageCount: number
  compactionCount: number
  lastExtractedAt?: number
  sessionMemoryUpdatedAt?: number
  todos?: TodoItem[]
  permissionMode?: import('./permission/types.js').PermissionMode
  userId?: string
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
