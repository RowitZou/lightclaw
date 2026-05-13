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

export type AttachmentKind = 'image' | 'pdf' | 'audio' | 'video'

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
  /**
   * Stable portion of the system prompt — persona, memory, skills, permission
   * summary, MCP catalog, tool descriptions. Providers should attach their
   * cache anchor (Anthropic cache_control, Codex/OAI automatic prefix match)
   * to this string so it stays a cache hit across turns where only `systemVariableSuffix`
   * changes.
   */
  system: string
  /**
   * Per-turn suffix — current TodoList, deferred-tools system-reminder.
   * Provider concatenates onto `system` (or emits a separate uncached block
   * on Anthropic) so the stable prefix is not invalidated when the agent
   * flips a todo state.
   */
  systemVariableSuffix?: string
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
  /**
   * Schema-static set of content kinds this provider's `convertMessages`
   * (or wire-shape translator) will unconditionally drop, regardless of
   * input combinatorics. Probed at provider construction by `getProviderFor`
   * to pre-charge `writeCacheEntry({enabled:false})` so the channel-runner's
   * `encodeAttachmentsForInline` skips generating those kinds in the first
   * place — no waste reading the bytes from disk, no waste base64-encoding,
   * no waste landing them in transcript / api-logs.
   *
   * Implementation pattern: feed a synthetic message containing one block
   * of each kind through the same `convertMessages` helper that streamChat
   * uses, and report whichever kinds got filtered out. Single source of
   * truth — the `streamChat` and `detectStaticDropKinds` answers cannot
   * drift, because the latter literally runs the former's translator.
   *
   * Returns `[]` when the provider supports every kind. Optional so legacy
   * providers keep working without modification (autopilot then waits for
   * the reactive 4xx catch path).
   */
  detectStaticDropKinds?(): readonly AttachmentKind[]

  /**
   * Same single-source-of-truth contract as `detectStaticDropKinds`, but
   * for kinds dropped when the block lives inside `tool_result.content`
   * rather than the top-level user-message content array. Two positions
   * because providers can differ: Anthropic accepts image + document in
   * both positions; OpenAI Chat Completions tool messages are string-only
   * (everything inside tool_result drops); OpenAI Responses today
   * stringifies `function_call_output.output` (same), but the wire
   * schema actually accepts an array of `input_text` / `input_image` /
   * `input_file` — so the right answer changes when the converter is
   * extended to emit that array shape.
   *
   * Phase 36 PR1 leaves the implementations as hardcoded constants that
   * mirror the current converter's pure-text behavior (since the
   * converter signature doesn't yet thread an `inToolResult` drop set
   * through `tool_result.content`). PR2 must update these probes to be
   * converter-derived alongside the converter rewrite that emits the
   * array shape — without that, the cache will keep recording
   * `enabled=false` for kinds the converter already supports, exactly
   * the codex/pdf incident shape.
   */
  detectStaticDropKindsInToolResult?(): readonly AttachmentKind[]
}
