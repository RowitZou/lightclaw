import type { StreamEvent } from '../types.js'

/** Wire protocol the provider speaks. The same physical endpoint may host
 *  both, distinguished per-model in `LightClawConfig.models`. */
export type Schema = 'anthropic' | 'openai'

/** @deprecated kept for back-compat in any in-tree caller; new code should
 *  use `Schema`. */
export type ProviderName = Schema

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
  cacheBreakpointMessageIndex?: number
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
  name: Schema
  capabilities: ProviderCapabilities
  streamChat(params: StreamChatParams): AsyncGenerator<StreamEvent>
  webSearch?(params: WebSearchParams): Promise<WebSearchResult>
}
