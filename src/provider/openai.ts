import OpenAI from 'openai'
import type {
  ChatCompletionContentPart,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions'

import type { ApiKeyEndpoint } from '../config.js'
import {
  toolResultContentToText,
  type AssistantContentBlock,
  type StreamEvent,
  type StreamStopEvent,
  type UsageStats,
  type UserToolResultBlock,
} from '../types.js'
import { dropOrphanToolResults } from './orphan-tool-result.js'
import { normalizeToolParametersForOpenAI } from './openai-tool-schema.js'
import { buildProxyAwareFetch, buildProxyDispatcher } from './proxy.js'
import { attachProviderRetryAfter } from './retry-after.js'
import { isReasoningUnsupportedError } from './reasoning.js'
import type { ApiMessage, AttachmentKind, Provider, StreamChatParams } from './types.js'

/** OpenAI Chat Completions has no slot for `document` (PDF) blocks anywhere
 *  in the schema, and audio/video are not natively expressable on this
 *  provider either. Surface every such block we silently skip during
 *  message conversion so the api.ts streamChat wrapper can flip the
 *  capability cache and stop generating these blocks upstream. */
function classifyUnsupportedBlock(blockType: unknown): AttachmentKind | null {
  if (blockType === 'document') return 'pdf'
  if (blockType === 'audio') return 'audio'
  if (blockType === 'video') return 'video'
  return null
}

type PendingToolCall = {
  id: string
  name: string
  args: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }

  if (Array.isArray(content)) {
    return content
      .map(block => {
        if (!isRecord(block)) {
          return ''
        }

        if (block.type === 'text' && typeof block.text === 'string') {
          return block.text
        }

        if (block.type === 'tool_result') {
          return toolResultContentToText(block.content as UserToolResultBlock['content'])
        }

        return ''
      })
      .filter(Boolean)
      .join('\n')
  }

  return String(content ?? '')
}

function convertMessages(
  system: string,
  messages: ApiMessage[],
  dropped?: Set<AttachmentKind>,
): ChatCompletionMessageParam[] {
  const converted: ChatCompletionMessageParam[] = [
    {
      role: 'system',
      content: system,
    },
  ]

  for (const message of messages) {
    if (message.role === 'user') {
      if (Array.isArray(message.content)) {
        // Mixed user content: emit each tool_result as a `role: 'tool'` message
        // (OpenAI's per-result message form) and concatenate any text blocks
        // into one `role: 'user'` message at the end. Mirrors the Anthropic
        // shape where tool_results + accompanying text live in a single user
        // message. Image / document blocks become OpenAI content parts
        // (image_url / file_id) on the trailing user message.
        const toolResults = message.content.filter(
          (block): block is UserToolResultBlock =>
            isRecord(block) && block.type === 'tool_result',
        )
        const textParts = message.content
          .filter(
            (block): block is { type: 'text'; text: string } =>
              isRecord(block) &&
              block.type === 'text' &&
              typeof block.text === 'string',
          )
          .map(block => block.text)
          .filter(text => text.length > 0)
        const imageBlocks = message.content.filter(
          (block): block is { type: 'image'; source: { type: 'base64'; mediaType: string; data: string } } =>
            isRecord(block) &&
            block.type === 'image' &&
            isRecord(block.source) &&
            block.source.type === 'base64',
        )
        // Classify any user-content block whose type isn't accepted by the
        // wire schema so the streamChat wrapper can flip the capability
        // cache to false. Without this, a `document` block silently falls
        // through every filter above and never reaches `converted` —
        // observable only by reading the raw transcript.
        if (dropped) {
          for (const block of message.content) {
            if (!isRecord(block)) continue
            const kind = classifyUnsupportedBlock(block.type)
            if (kind) dropped.add(kind)
          }
        }

        for (const block of toolResults) {
          // OpenAI Chat Completions tool messages require string content;
          // collapse array shape (image blocks already replaced with text
          // by the multimodal-finalization pass on this provider).
          converted.push({
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content: toolResultContentToText(block.content),
          })
        }
        if (textParts.length > 0 || imageBlocks.length > 0) {
          if (imageBlocks.length === 0) {
            converted.push({
              role: 'user',
              content: textParts.join('\n'),
            })
          } else {
            // Mixed text + image: use OpenAI content parts. PDF inline is
            // not pushed here because OpenAI Chat Completions does not have
            // an equivalent of Anthropic's `document` block — pdf goes to
            // the text path on this provider via the capability flag, and
            // the agent uses Read tool instead.
            const parts: ChatCompletionContentPart[] = []
            for (const text of textParts) {
              parts.push({ type: 'text', text })
            }
            for (const block of imageBlocks) {
              parts.push({
                type: 'image_url',
                image_url: {
                  url: `data:${block.source.mediaType};base64,${block.source.data}`,
                },
              })
            }
            converted.push({
              role: 'user',
              content: parts,
            })
          }
        }
        if (toolResults.length > 0 || textParts.length > 0 || imageBlocks.length > 0) {
          continue
        }
      }

      converted.push({
        role: 'user',
        content: contentToText(message.content),
      })
      continue
    }

    const contentBlocks = Array.isArray(message.content)
      ? message.content
      : []
    const text = contentBlocks
      .filter(
        (block): block is Extract<AssistantContentBlock, { type: 'text' }> =>
          isRecord(block) && block.type === 'text',
      )
      .map(block => block.text)
      .join('')
    const toolCalls = contentBlocks
      .filter(
        (block): block is Extract<
          AssistantContentBlock,
          { type: 'tool_use' }
        > => isRecord(block) && block.type === 'tool_use',
      )
      .map(block => ({
        id: block.id,
        type: 'function' as const,
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input),
        },
      }))

    converted.push({
      role: 'assistant',
      content: text.length > 0 ? text : null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    })
  }

  return converted
}

function convertTools(tools: StreamChatParams['tools']): ChatCompletionTool[] {
  return tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: normalizeToolParametersForOpenAI(
        tool.input_schema as Record<string, unknown>,
      ),
    },
  }))
}

export function mapUsage(usage: unknown): UsageStats {
  if (!isRecord(usage)) {
    return {}
  }

  const result: UsageStats = {}
  if (typeof usage.prompt_tokens === 'number') {
    result.input_tokens = usage.prompt_tokens
  }
  if (typeof usage.completion_tokens === 'number') {
    result.output_tokens = usage.completion_tokens
  }
  // OpenAI Chat Completions reports prefix cache hits under the nested
  // `prompt_tokens_details.cached_tokens` field. Anthropic uses
  // `cache_read_input_tokens` as the canonical name; we surface OpenAI's
  // nested value through the same canonical slot. OpenAI has no explicit
  // cache-creation step (caching is automatic on prefix matches), so
  // `cache_creation_input_tokens` stays absent.
  //
  // Crucially, OpenAI's `prompt_tokens` is the TOTAL input-side count and
  // `cached_tokens` is a SUBSET of it (not a disjoint bucket). Anthropic's
  // canonical `input_tokens` instead EXCLUDES cache reads, with the three
  // buckets (input + cache_read + cache_creation) summing to the total. Every
  // downstream consumer (`/admin cost` totals, TaskRun usage rollups, the task-card
  // cache-hit rate) assumes the disjoint Anthropic convention. So subtract the
  // cached portion here to normalize `input_tokens` to fresh-only; otherwise
  // the cached tokens are counted twice (once inside `input_tokens`, once in
  // `cache_read_input_tokens`) and e.g. the hit rate is understated.
  const details = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : null
  if (details && typeof details.cached_tokens === 'number') {
    result.cache_read_input_tokens = details.cached_tokens
    if (typeof result.input_tokens === 'number') {
      result.input_tokens = Math.max(0, result.input_tokens - details.cached_tokens)
    }
  }
  return result
}

export function createOpenAIProvider(endpoint: ApiKeyEndpoint): Provider {
  // Dispatcher / fetch / SDK client are mutable, NOT const. See
  // `openai-auth.ts` recycle doc for rationale.
  let proxyDispatcher = buildProxyDispatcher(endpoint.proxy)
  let proxyFetch = buildProxyAwareFetch(proxyDispatcher)
  let client = new OpenAI({
    apiKey: endpoint.apiKey,
    ...(endpoint.baseUrl ? { baseURL: endpoint.baseUrl } : {}),
    ...(proxyFetch ? { fetch: proxyFetch } : {}),
  })
  function rebuildClient(): void {
    client = new OpenAI({
      apiKey: endpoint.apiKey,
      ...(endpoint.baseUrl ? { baseURL: endpoint.baseUrl } : {}),
      ...(proxyFetch ? { fetch: proxyFetch } : {}),
    })
  }

  return {
    name: 'openai',
    capabilities: {
      serverTools: {
        webSearch: false,
      },
      promptCaching: false,
    },
    recycleConnections() {
      if (proxyDispatcher) {
        void proxyDispatcher.close().catch(() => {})
      }
      proxyDispatcher = buildProxyDispatcher(endpoint.proxy)
      proxyFetch = buildProxyAwareFetch(proxyDispatcher)
      rebuildClient()
    },
    async *streamChat(params: StreamChatParams): AsyncGenerator<StreamEvent> {
      const pendingTools = new Map<number, PendingToolCall>()
      let text = ''
      let usage: UsageStats = {}
      let finishReason: string | null = null
      let sawAnyChunk = false

      const sanitizedMessages = dropOrphanToolResults(params.messages)
      // Drop tracking is surfaced through `detectStaticDropKinds()`
      // (run once at construction by `getProviderFor` → capability cache).
      // The schema is deterministic, so a runtime event would just rewrite
      // the same cache bit the static probe already set. Wire-side errors
      // that ARE context-sensitive (e.g., proxy strips an image_url, model
      // version difference) still go through `isCapabilityMissingError`
      // catch in `channels/runner.ts`.
      // `params.system` is guaranteed stable across turns of one query
      // loop; per-turn volatile state lives in the last user message
      // (injected by the framework, see messages.ts
      // `injectSystemReminderIntoLastUserMessage`). Do NOT splice any
      // per-turn content into the system message here — that breaks the
      // OpenAI auto prefix-cache fingerprint for the entire `messages`
      // tail.
      const wireMessages = convertMessages(params.system, sanitizedMessages)
      // `reasoning_effort` is the native Chat Completions reasoning knob
      // (none|minimal|low|medium|high|xhigh on current reasoning models; cast
      // because the installed SDK enum may be narrower than our 6-value union).
      // Sent for every configured value, including 'none' (which disables
      // reasoning on gpt-5.2+). A non-reasoning model — or an OpenAI-compatible
      // endpoint that doesn't accept the field — trips the strip-retry below.
      const wantsReasoning = Boolean(params.reasoningEffort)
      const makeStream = (withReasoning: boolean) =>
        client.chat.completions.create({
          model: params.model,
          messages: wireMessages,
          tools: params.tools.length > 0 ? convertTools(params.tools) : undefined,
          max_tokens: params.maxTokens ?? 8192,
          ...(withReasoning && params.reasoningEffort
            ? { reasoning_effort: params.reasoningEffort as never }
            : {}),
          stream: true,
          stream_options: {
            include_usage: true,
          },
        }, {
          signal: params.signal,
        })

      let stream: Awaited<ReturnType<typeof client.chat.completions.create>>
      try {
        stream = await makeStream(wantsReasoning)
      } catch (error) {
        if (wantsReasoning && isReasoningUnsupportedError(error)) {
          process.stderr.write(
            `[openai] model "${params.model}" rejected reasoning_effort; retrying without it\n`,
          )
          try {
            stream = await makeStream(false)
          } catch (retryError) {
            throw attachProviderRetryAfter(retryError)
          }
        } else {
          throw attachProviderRetryAfter(error)
        }
      }

      for await (const chunk of stream) {
        sawAnyChunk = true
        usage = {
          ...usage,
          ...mapUsage(chunk.usage),
        }

        const choice = chunk.choices[0]
        if (!choice) {
          continue
        }

        if (choice.finish_reason) {
          finishReason = choice.finish_reason
        }

        const delta = choice.delta
        const reasoningDelta = (delta as {
          reasoning?: unknown
          reasoning_content?: unknown
        }).reasoning_content ?? (delta as { reasoning?: unknown }).reasoning
        if (typeof reasoningDelta === 'string' && reasoningDelta.length > 0) {
          yield { type: 'keepalive', reason: 'reasoning' }
        }
        if (typeof delta.content === 'string' && delta.content.length > 0) {
          text += delta.content
          yield {
            type: 'text',
            text: delta.content,
          }
        }

        let yieldedToolArgsKeepalive = false
        for (const toolCall of delta.tool_calls ?? []) {
          const index = toolCall.index
          const current = pendingTools.get(index) ?? {
            id: '',
            name: '',
            args: '',
          }
          if (toolCall.id) {
            current.id = toolCall.id
          }
          if (toolCall.function?.name) {
            current.name = toolCall.function.name
          }
          if (toolCall.function?.arguments) {
            current.args += toolCall.function.arguments
            // Symmetric to reasoning_content / content deltas: emit one
            // framework keepalive per chunk that carries any non-empty
            // tool-args wire activity so query.ts's idle watchdog clock
            // resets while the model is actively streaming tool-call
            // arguments. Without this the watchdog goes blind for the
            // entire duration of tool_call args streaming because the
            // accumulator (current.args) is internal state, not a yielded
            // event. Yield at most once per chunk even with multiple
            // parallel tool_calls — they share the same wire chunk and
            // one keepalive marker is enough to anchor the clock. See
            // `# LightClaw Runtime Safety Notes` keepalive contract for
            // the `'tool-args'` reason.
            if (toolCall.function.arguments.length > 0 && !yieldedToolArgsKeepalive) {
              yield { type: 'keepalive', reason: 'tool-args' }
              yieldedToolArgsKeepalive = true
            }
          }
          pendingTools.set(index, current)
        }
      }

      const content: AssistantContentBlock[] = []
      if (text.length > 0) {
        content.push({
          type: 'text',
          text,
        })
      }

      for (const [index, toolCall] of [...pendingTools.entries()].sort(
        ([left], [right]) => left - right,
      )) {
        const input =
          toolCall.args.trim().length === 0
            ? {}
            : (JSON.parse(toolCall.args) as Record<string, unknown>)
        const id = toolCall.id || `tool_call_${index}`
        const block = {
          type: 'tool_use' as const,
          id,
          name: toolCall.name,
          input,
        }
        content.push(block)
        yield {
          type: 'tool_use',
          id,
          name: toolCall.name,
          input,
          index,
        }
      }

      // Empty / dead-stream guard, symmetric with openai-auth.ts and
      // anthropic.ts: a Chat Completions stream that closes with zero chunks —
      // or one that never delivered a finish_reason, content, or usage — is an
      // upstream/proxy EOF, not a finished turn. Without this throw the
      // `finishReason ?? 'end_turn'` fallback below persists a `content: []`
      // assistant message that reads as a normal end_turn, and the user sees
      // "no reply". Throw so query.ts's transient retry re-runs the call.
      if (
        !sawAnyChunk ||
        (content.length === 0 && finishReason === null && Object.keys(usage).length === 0)
      ) {
        throw new Error(
          'OpenAI stream returned no events (likely upstream/proxy hiccup); a retry should recover.',
        )
      }
      const stopEvent: StreamStopEvent = {
        type: 'stop',
        stopReason:
          finishReason === 'tool_calls'
            ? 'tool_use'
            : finishReason === 'length'
              ? 'max_tokens'
              : 'end_turn',
        usage,
        content,
      }
      yield stopEvent
    },
    detectStaticDropKinds(): readonly AttachmentKind[] {
      // Probe: synthesize a user message with one block of every attachment
      // kind and run it through the same convertMessages this provider's
      // streamChat uses. Kinds that fall out as `dropped` are the ones the
      // wire schema cannot represent — return them so getProviderFor() can
      // pre-charge disabled cache entries before any real PDF / audio /
      // video upload reaches encodeAttachmentsForInline.
      const probe: ApiMessage[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: '' },
            { type: 'image', source: { type: 'base64', mediaType: 'image/jpeg', data: '' } },
            { type: 'document', source: { type: 'base64', mediaType: 'application/pdf', data: '' } },
            { type: 'audio', source: { type: 'base64', mediaType: 'audio/mpeg', data: '' } },
            { type: 'video', source: { type: 'base64', mediaType: 'video/mp4', data: '' } },
          ],
        },
      ]
      const dropped = new Set<AttachmentKind>()
      convertMessages('', probe, dropped)
      return Array.from(dropped)
    },
    detectStaticDropKindsInToolResult(): readonly AttachmentKind[] {
      // Chat Completions tool messages take `content: string` — the
      // converter `toolResultContentToText`-s any image / document /
      // audio / video block into a placeholder text. Hardcoded for now;
      // unlike openai-auth (Responses) this list is unlikely to change
      // unless OpenAI rolls out a structured tool-message content shape,
      // at which point: (1) extend the converter to emit it, (2) thread
      // an `inToolResult` drop set through, (3) make this probe
      // converter-derived. Until then a converter regression silently
      // keeps the hardcoded answer correct (which is the point of the
      // single-source-of-truth invariant — don't drift).
      return ['image', 'pdf', 'audio', 'video']
    },
    async describeImage(params) {
      const images = params.images ?? (params.image ? [params.image] : [])
      if (images.length === 0) {
        throw new Error('describeImage requires at least one image.')
      }
      let completion: Awaited<ReturnType<typeof client.chat.completions.create>>
      try {
        completion = await client.chat.completions.create({
          model: params.model,
          messages: [
            ...(params.system
              ? [{ role: 'system' as const, content: params.system }]
              : []),
            {
              role: 'user',
              content: [
                { type: 'text', text: params.prompt },
                ...images.map(image => ({
                  type: 'image_url',
                  image_url: {
                    url: `data:${image.mimeType};base64,${image.buffer.toString('base64')}`,
                  },
                } as const)),
              ],
            },
          ],
          max_tokens: params.maxTokens ?? 1200,
        }, {
          signal: params.signal,
        })
      } catch (error) {
        throw attachProviderRetryAfter(error)
      }
      return {
        text: completion.choices[0]?.message.content ?? '',
        model: completion.model,
      }
    },
    async transcribeAudio(params) {
      const arrayBuffer = params.audio.buffer.buffer.slice(
        params.audio.buffer.byteOffset,
        params.audio.buffer.byteOffset + params.audio.buffer.byteLength,
      ) as ArrayBuffer
      const file = new File(
        [arrayBuffer],
        params.audio.fileName ?? 'audio',
        params.audio.mimeType ? { type: params.audio.mimeType } : undefined,
      )
      let transcription: Awaited<ReturnType<typeof client.audio.transcriptions.create>>
      try {
        transcription = await client.audio.transcriptions.create({
          file,
          model: params.model ?? 'whisper-1',
          ...(params.prompt ? { prompt: params.prompt } : {}),
          ...(params.language ? { language: params.language } : {}),
        }, {
          signal: params.signal,
        })
      } catch (error) {
        throw attachProviderRetryAfter(error)
      }
      return {
        text: transcription.text,
        model: params.model ?? 'whisper-1',
      }
    },
  }
}
