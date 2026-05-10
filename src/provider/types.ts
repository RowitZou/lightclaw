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
  /** Per-attachment-kind inline support flags. Three states:
   *    true     — provider documented to accept this kind inline; submit it
   *    false    — provider rejects this kind inline; fall back to text path
   *    'unknown' — never tested for this endpoint × upstream-model combo;
   *                runner submits inline, autopilot flips on capability-
   *                missing error, and the cache persists the verdict so
   *                subsequent turns skip the wasted round-trip.
   *  Defaults are 'unknown' for image/pdf (we'll discover at first use);
   *  audio/video stay false until provider audio/video APIs are wired. */
  attachments: {
    image: AttachmentCapability
    pdf: AttachmentCapability
    audio: AttachmentCapability
    video: AttachmentCapability
  }
}

export type AttachmentKind = 'image' | 'pdf' | 'audio' | 'video'

export type AttachmentCapability = boolean | 'unknown'

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
  /**
   * Schema-static set of content kinds this provider's `convertMessages`
   * (or wire-shape translator) will unconditionally drop, regardless of
   * input combinatorics. Probed at provider construction by `getProviderFor`
   * to pre-charge `recordCapability(false)` so the channel-runner's
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
   * the runtime `content_dropped` event or the reactive 4xx catch path).
   */
  detectStaticDropKinds?(): readonly AttachmentKind[]
}
