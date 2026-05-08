import type { StreamEvent } from '../types.js'

/** Wire protocol the provider speaks. The same physical endpoint may host
 *  both, distinguished per-model in `LightClawConfig.models`. `openai-auth`
 *  uses the OpenAI Responses API on the Codex backend
 *  (chatgpt.com/backend-api/codex) with OAuth credentials sourced from the
 *  endpoint's auth provider. */
export type Schema = 'anthropic' | 'openai' | 'openai-auth'

export type ReasoningEffort = 'low' | 'medium' | 'high'

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
  reasoningEffort?: ReasoningEffort
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

export type DescribeImageInput = {
  buffer: Buffer
  mimeType: string
  fileName?: string
}

export type DescribeImageParams = {
  model: string
  prompt: string
  system?: string
  image?: DescribeImageInput
  images?: DescribeImageInput[]
  maxTokens?: number
  reasoningEffort?: ReasoningEffort
  signal?: AbortSignal
}

export type DescribeImageResult = {
  text: string
  model?: string
}

export type TranscribeAudioParams = {
  model?: string
  audio: {
    buffer: Buffer
    mimeType?: string
    fileName?: string
  }
  prompt?: string
  language?: string
  signal?: AbortSignal
}

export type TranscribeAudioResult = {
  text: string
  model?: string
}

export type Provider = {
  name: Schema
  capabilities: ProviderCapabilities
  streamChat(params: StreamChatParams): AsyncGenerator<StreamEvent>
  webSearch?(params: WebSearchParams): Promise<WebSearchResult>
  describeImage?(params: DescribeImageParams): Promise<DescribeImageResult>
  transcribeAudio?(params: TranscribeAudioParams): Promise<TranscribeAudioResult>
}
