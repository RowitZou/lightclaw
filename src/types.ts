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
  message: {
    role: 'user'
    content: string | UserToolResultBlock[]
  }
}

export type AssistantMessage = {
  type: 'assistant'
  uuid: string
  message: {
    role: 'assistant'
    content: AssistantContentBlock[]
    stop_reason: string | null
    usage: UsageStats
  }
}

export type Message = UserMessage | AssistantMessage

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