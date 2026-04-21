import type { StreamEvent } from '../types.js'

export type ProviderName = 'anthropic' | 'openai'

export type ProviderCapabilities = {
  serverTools: {
    webSearch: boolean
  }
  promptCaching: boolean
}

export type ApiMessage = {
  role: 'user' | 'assistant'
  content: unknown
}

export type ToolSchema = {
  name: string
  description: string
  input_schema: object
}

export type StreamChatParams = {
  model: string
  messages: ApiMessage[]
  system: string
  tools: ToolSchema[]
  maxTokens?: number
  signal?: AbortSignal
}

export type WebSearchParams = {
  query: string
  model: string
  allowedDomains?: string[]
  blockedDomains?: string[]
  maxUses?: number
  maxTokens?: number
  signal?: AbortSignal
}

export type WebSearchResult = {
  text: string
}

export type Provider = {
  name: ProviderName
  capabilities: ProviderCapabilities
  streamChat(params: StreamChatParams): AsyncGenerator<StreamEvent>
  webSearch?(params: WebSearchParams): Promise<WebSearchResult>
}
