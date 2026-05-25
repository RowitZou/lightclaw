import Anthropic from '@anthropic-ai/sdk'

import type { ApiKeyEndpoint } from '../config.js'
import { buildProxyAwareFetch, buildProxyDispatcher } from './proxy.js'
import type {
  AssistantContentBlock,
  StreamEvent,
  StreamStopEvent,
  UsageStats,
} from '../types.js'
import type {
  DescribeImageParams,
  DescribeImageResult,
  Provider,
  StreamChatParams,
  WebSearchParams,
  WebSearchResult,
} from './types.js'

type PendingToolUseBlock = {
  type: 'tool_use'
  id: string
  name: string
  input: string
}

type CacheControl = { type: 'ephemeral' }

const EPHEMERAL_CACHE: CacheControl = { type: 'ephemeral' }

function isPendingToolUseBlock(
  block: AssistantContentBlock | PendingToolUseBlock,
): block is PendingToolUseBlock {
  return block.type === 'tool_use' && typeof block.input === 'string'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function normalizeUsage(value: unknown): UsageStats {
  if (!isRecord(value)) {
    return {}
  }

  const usage: UsageStats = {}
  for (const key of [
    'input_tokens',
    'output_tokens',
    'cache_creation_input_tokens',
    'cache_read_input_tokens',
  ] as const) {
    const tokenValue = value[key]
    if (typeof tokenValue === 'number') {
      usage[key] = tokenValue
    }
  }
  return usage
}

function mergeUsage(base: UsageStats, next: UsageStats): UsageStats {
  return {
    input_tokens: next.input_tokens ?? base.input_tokens,
    output_tokens: next.output_tokens ?? base.output_tokens,
    cache_creation_input_tokens:
      next.cache_creation_input_tokens ?? base.cache_creation_input_tokens,
    cache_read_input_tokens:
      next.cache_read_input_tokens ?? base.cache_read_input_tokens,
  }
}

function withCacheControl<T extends Record<string, unknown>>(block: T): T {
  return {
    ...block,
    cache_control: EPHEMERAL_CACHE,
  }
}

function cacheSystem(
  system: string,
  variableSuffix?: string,
): Array<Record<string, unknown>> {
  // Anchor cache_control to the stable prefix only when a variable suffix is
  // present. The suffix (TodoList, deferred-tools reminder) re-tokenizes
  // each turn; pinning the breakpoint to the prefix keeps the persona +
  // memory + tool-catalog block as a cache hit across turns. When no suffix
  // is supplied (custom-systemPrompt callers, recall/session-memory model
  // calls), fall back to the legacy single-block shape.
  const prefix = {
    type: 'text',
    text: system,
    cache_control: EPHEMERAL_CACHE,
  }
  if (!variableSuffix) {
    return [prefix]
  }
  return [
    prefix,
    {
      type: 'text',
      text: variableSuffix,
    },
  ]
}

function cacheTools(tools: unknown[]): unknown[] {
  if (tools.length === 0) {
    return tools
  }
  return tools.map((tool, index) => {
    if (index !== tools.length - 1 || !isRecord(tool)) {
      return tool
    }
    return withCacheControl(tool)
  })
}

function asContentBlocks(content: unknown): Array<Record<string, unknown>> {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }]
  }
  if (Array.isArray(content)) {
    return content.map(block =>
      isRecord(block)
        ? translateBlockToAnthropicShape(block)
        : { type: 'text', text: String(block) },
    )
  }
  return [{ type: 'text', text: String(content ?? '') }]
}

/** Anthropic's Messages API uses snake_case for `media_type`; LightClaw's
 *  internal UserContentBlock uses camelCase `mediaType` (matches the rest
 *  of the codebase's convention and TypeScript style). Image and document
 *  blocks need translation; text blocks pass through. tool_result blocks
 *  with array `content` (multimodal Read / pdf-pages output) recurse so
 *  image blocks nested inside also get the camelCase→snake_case fix. */
function translateBlockToAnthropicShape(block: Record<string, unknown>): Record<string, unknown> {
  if (block.type === 'image' || block.type === 'document') {
    const source = isRecord(block.source) ? block.source : null
    if (source && source.type === 'base64' && typeof source.mediaType === 'string') {
      return {
        ...block,
        source: {
          type: 'base64',
          media_type: source.mediaType,
          data: source.data,
        },
      }
    }
  }
  if (block.type === 'tool_result' && Array.isArray(block.content)) {
    return {
      ...block,
      content: block.content.map(inner =>
        isRecord(inner) ? translateBlockToAnthropicShape(inner) : inner,
      ),
    }
  }
  return { ...block }
}

function cacheMessageContent(content: unknown): Array<Record<string, unknown>> {
  const blocks = asContentBlocks(content)
  if (blocks.length === 0) {
    return blocks
  }
  return blocks.map((block, index) =>
    index === blocks.length - 1 ? withCacheControl(block) : block,
  )
}

function cacheMessages(
  messages: Array<{ role: 'user' | 'assistant'; content: unknown }>,
  cacheBreakpointMessageIndex?: number,
): Array<{ role: 'user' | 'assistant'; content: unknown }> {
  const breakpoints = new Set<number>()
  if (cacheBreakpointMessageIndex !== undefined) {
    for (
      let index = Math.min(cacheBreakpointMessageIndex, messages.length - 1);
      index >= 0;
      index -= 1
    ) {
      if (messages[index]?.role === 'user') {
        breakpoints.add(index)
        break
      }
    }
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      breakpoints.add(index)
      break
    }
  }

  return messages.map((message, index) => {
    if (breakpoints.has(index)) {
      return {
        ...message,
        content: cacheMessageContent(message.content),
      }
    }
    // Non-cached user messages still need image / document mediaType
    // translation; only assistant messages are pass-through. This keeps
    // historical attachments in the transcript replayable.
    if (message.role === 'user' && Array.isArray(message.content)) {
      return {
        ...message,
        content: asContentBlocks(message.content),
      }
    }
    return message
  })
}

// Parse the accumulated `input_json_delta` payload for one tool_use block.
// Returns `{}` on JSON.parse failure rather than throwing — mirrors Claude
// Code's `safeParseJSON` fallback (utils/messages.ts normalizeContentFromAPI):
// the streaming layer must never crash the whole agent loop because the model
// emitted slightly malformed JSON (or because an upstream proxy truncated a
// partial_json delta). With input degraded to `{}`, the tool's Zod schema
// validation will fail in dispatchToolCall and surface a tool_result with
// `is_error: true` ("Invalid input for X: ..."), which the model can read
// and retry on its own.
function safeParseToolInput(
  toolName: string,
  rawInput: string,
): Record<string, unknown> {
  if (rawInput.trim().length === 0) {
    return {}
  }
  try {
    return JSON.parse(rawInput) as Record<string, unknown>
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const preview = rawInput.slice(0, 200)
    process.stderr.write(
      `[provider/anthropic] tool_use input JSON parse failed for ${toolName}: ${detail}; raw[0..200]=${preview}\n`,
    )
    return {}
  }
}

function finalizeContentBlocks(
  blocks: Map<number, AssistantContentBlock | PendingToolUseBlock>,
): AssistantContentBlock[] {
  return [...blocks.entries()]
    .sort(([leftIndex], [rightIndex]) => leftIndex - rightIndex)
    .map(([, block]) => {
      if (block.type === 'text') {
        return block
      }

      if (!isPendingToolUseBlock(block)) {
        return block
      }

      return {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: safeParseToolInput(block.name, block.input),
      }
    })
}

function formatWebSearchBlocks(blocks: unknown[]): string {
  const lines: string[] = []

  for (const block of blocks) {
    if (!isRecord(block)) {
      continue
    }

    if (block.type === 'text' && typeof block.text === 'string') {
      lines.push(block.text)
      continue
    }

    if (block.type !== 'server_tool_use' && block.type !== 'web_search_tool_result') {
      continue
    }

    const content = block.content
    if (!Array.isArray(content)) {
      continue
    }

    for (const item of content) {
      if (!isRecord(item)) {
        continue
      }

      const title = typeof item.title === 'string' ? item.title : 'Untitled'
      const url = typeof item.url === 'string' ? item.url : ''
      const suffix =
        typeof item.page_age === 'string' ? ` (${item.page_age})` : ''
      lines.push(url ? `- ${title}: ${url}${suffix}` : `- ${title}${suffix}`)
    }
  }

  return lines.join('\n').trim()
}

export function createAnthropicProvider(endpoint: ApiKeyEndpoint): Provider {
  const baseURL = endpoint.baseUrl
  const proxyFetch = buildProxyAwareFetch(buildProxyDispatcher(endpoint.proxy))
  const client = new Anthropic({
    apiKey: endpoint.apiKey,
    ...(baseURL ? { baseURL } : {}),
    ...(proxyFetch ? { fetch: proxyFetch } : {}),
  })
  // Server-side WebSearch is only supported by Anthropic's first-party API.
  // Third-party gateways (Bedrock-backed New API, etc.) usually don't proxy
  // it cleanly, so we gate by absence of baseUrl as a conservative proxy
  // for "talking to api.anthropic.com".
  const webSearchSupported = !baseURL

  return {
    name: 'anthropic',
    capabilities: {
      serverTools: {
        webSearch: webSearchSupported,
      },
      promptCaching: true,
    },
    detectStaticDropKinds(): readonly ['audio', 'video'] {
      // Messages accepts image + document blocks. LightClaw has no audio /
      // video block translation for Anthropic chat, so precharge disables
      // them before attachment encoding reads bytes.
      return ['audio', 'video']
    },
    detectStaticDropKindsInToolResult(): readonly ['audio', 'video'] {
      // tool_result.content accepts image + document blocks too; audio /
      // video remain unsupported by the converter and wire target.
      // Hardcoded because `translateBlockToAnthropicShape` doesn't yet
      // surface drops via a set parameter (image / document pass through
      // unchanged; audio / video also pass through but Anthropic API
      // 400s on them — same outcome as "dropped at translation"). If
      // PR2 threads a drop set through the recursive translator, swap
      // this for the converter-derived equivalent so it auto-adjusts
      // when the converter gains new emit branches.
      return ['audio', 'video']
    },
    async *streamChat(params: StreamChatParams): AsyncGenerator<StreamEvent> {
      const stream = await client.messages.create({
        model: params.model,
        max_tokens: params.maxTokens ?? 8192,
        system: cacheSystem(params.system, params.systemVariableSuffix) as never,
        messages: cacheMessages(
          params.messages,
          params.cacheBreakpointMessageIndex,
        ) as never,
        tools: cacheTools(params.tools) as never,
        stream: true,
      }, {
        signal: params.signal,
      })

      const contentBlocks = new Map<
        number,
        AssistantContentBlock | PendingToolUseBlock
      >()
      let usage: UsageStats = {}
      let stopReason: string | null = null
      let sawAnyEvent = false

      for await (const part of stream as AsyncIterable<unknown>) {
        sawAnyEvent = true
        if (!isRecord(part) || typeof part.type !== 'string') {
          continue
        }

        // Anthropic Messages stream emits `event: ping` as a transport
        // heartbeat (analogous to OpenAI Responses' `event: keepalive`).
        // Without forwarding it as a framework keepalive, query.ts's idle
        // clock counts only business events and a long extended-thinking
        // turn could falsely trip the inter-event watchdog. This is
        // defense-in-depth: dogfood goes through newapi (which may or
        // may not relay ping through its proxy), but when LightClaw
        // talks directly to Anthropic, ping is a real wire-level signal
        // and must reset the idle clock.
        if (part.type === 'ping') {
          yield { type: 'keepalive', reason: 'transport' }
          continue
        }

        switch (part.type) {
          case 'message_start': {
            const message = isRecord(part.message) ? part.message : undefined
            usage = mergeUsage(usage, normalizeUsage(message?.usage))
            break
          }
          case 'content_block_start': {
            const index = typeof part.index === 'number' ? part.index : -1
            const contentBlock = isRecord(part.content_block)
              ? part.content_block
              : undefined
            if (
              index < 0 ||
              !contentBlock ||
              typeof contentBlock.type !== 'string'
            ) {
              break
            }

            if (contentBlock.type === 'text') {
              contentBlocks.set(index, {
                type: 'text',
                text: '',
              })
            }

            if (
              contentBlock.type === 'tool_use' &&
              typeof contentBlock.id === 'string' &&
              typeof contentBlock.name === 'string'
            ) {
              contentBlocks.set(index, {
                type: 'tool_use',
                id: contentBlock.id,
                name: contentBlock.name,
                input: '',
              })
            }

            // Thinking blocks must be captured (and later round-tripped with
            // their signature) or the next request errors as 400 "Improperly
            // formed request" — see types.ts:AssistantThinkingBlock.
            if (contentBlock.type === 'thinking') {
              contentBlocks.set(index, {
                type: 'thinking',
                thinking: typeof contentBlock.thinking === 'string'
                  ? contentBlock.thinking
                  : '',
                signature: typeof contentBlock.signature === 'string'
                  ? contentBlock.signature
                  : '',
              })
            }

            // Redacted thinking carries an opaque payload we must echo back
            // verbatim. Treat the initial value as authoritative; no deltas
            // are streamed for redacted blocks.
            if (
              contentBlock.type === 'redacted_thinking' &&
              typeof contentBlock.data === 'string'
            ) {
              contentBlocks.set(index, {
                type: 'redacted_thinking',
                data: contentBlock.data,
              })
            }
            break
          }
          case 'content_block_delta': {
            const index = typeof part.index === 'number' ? part.index : -1
            const delta = isRecord(part.delta) ? part.delta : undefined
            const contentBlock = contentBlocks.get(index)
            if (
              index < 0 ||
              !delta ||
              !contentBlock ||
              typeof delta.type !== 'string'
            ) {
              break
            }

            if (delta.type === 'text_delta' && contentBlock.type === 'text') {
              const text = typeof delta.text === 'string' ? delta.text : ''
              contentBlock.text += text
              if (text.length > 0) {
                yield {
                  type: 'text',
                  text,
                }
              }
            }

            if (
              delta.type === 'input_json_delta' &&
              contentBlock.type === 'tool_use'
            ) {
              const partialJson =
                typeof delta.partial_json === 'string'
                  ? delta.partial_json
                  : ''
              contentBlock.input += partialJson
            }

            if (
              delta.type === 'thinking_delta' &&
              contentBlock.type === 'thinking'
            ) {
              const t = typeof delta.thinking === 'string' ? delta.thinking : ''
              contentBlock.thinking += t
              if (t.length > 0) {
                yield { type: 'keepalive', reason: 'reasoning' }
              }
            }

            // Signature is delivered as a single delta near the end of a
            // thinking block; replace rather than append (it's a complete
            // base64 token, not a partial).
            if (
              delta.type === 'signature_delta' &&
              contentBlock.type === 'thinking' &&
              typeof delta.signature === 'string'
            ) {
              contentBlock.signature = delta.signature
            }
            break
          }
          case 'content_block_stop': {
            const index = typeof part.index === 'number' ? part.index : -1
            const contentBlock = contentBlocks.get(index)
            if (
              index < 0 ||
              !contentBlock ||
              !isPendingToolUseBlock(contentBlock)
            ) {
              break
            }

            const input = safeParseToolInput(contentBlock.name, contentBlock.input)
            const finalized = {
              type: 'tool_use' as const,
              id: contentBlock.id,
              name: contentBlock.name,
              input,
            }
            contentBlocks.set(index, finalized)
            yield {
              type: 'tool_use',
              id: finalized.id,
              name: finalized.name,
              input: finalized.input,
              index,
            }
            break
          }
          case 'message_delta': {
            const delta = isRecord(part.delta) ? part.delta : undefined
            if (delta && typeof delta.stop_reason === 'string') {
              stopReason = delta.stop_reason
            }

            usage = mergeUsage(usage, normalizeUsage(part.usage))
            break
          }
        }
      }

      const finalContent = finalizeContentBlocks(contentBlocks)
      // A stream that closed without yielding any events at all (or yielded
      // events but produced no content blocks AND no stop_reason AND no
      // usage) is the signature of an upstream/proxy hiccup that silently
      // closed the SSE connection. Without this guard we'd persist an empty
      // assistant message into the transcript, which then poisons every
      // subsequent turn (Anthropic rejects messages with content: []), and
      // the user sees a cascade of "(no response)" replies on Feishu.
      if (
        !sawAnyEvent ||
        (finalContent.length === 0 && stopReason === null && Object.keys(usage).length === 0)
      ) {
        throw new Error(
          'Anthropic stream returned no events (likely upstream/proxy hiccup); a retry should recover.',
        )
      }
      const stopEvent: StreamStopEvent = {
        type: 'stop',
        stopReason,
        usage,
        content: finalContent,
      }
      yield stopEvent
    },
    async describeImage(
      params: DescribeImageParams,
    ): Promise<DescribeImageResult> {
      const images = params.images ?? (params.image ? [params.image] : [])
      if (images.length === 0) {
        throw new Error('describeImage requires at least one image.')
      }
      const response = await client.messages.create(
        {
          model: params.model,
          max_tokens: params.maxTokens ?? 1200,
          ...(params.system ? { system: params.system } : {}),
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: params.prompt },
                ...images.map(image => ({
                  type: 'image' as const,
                  source: {
                    type: 'base64' as const,
                    // Anthropic SDK accepts the four standard vision MIME
                    // types plus aliases; cast through `as never` because
                    // upstream typings narrow further than runtime requires.
                    media_type: image.mimeType,
                    data: image.buffer.toString('base64'),
                  },
                })),
              ],
            },
          ],
        } as never,
        {
          signal: params.signal,
        },
      )
      const textParts: string[] = []
      for (const block of response.content as unknown[]) {
        if (
          isRecord(block) &&
          block.type === 'text' &&
          typeof block.text === 'string'
        ) {
          textParts.push(block.text)
        }
      }
      return {
        text: textParts.join(''),
        model: response.model ?? params.model,
      }
    },
    ...(webSearchSupported
      ? {
          async webSearch(
            webSearchParams: WebSearchParams,
          ): Promise<WebSearchResult> {
            const response = await client.messages.create(
              {
                model: webSearchParams.model,
                max_tokens: webSearchParams.maxTokens ?? 4096,
                system:
                  'You are a web search assistant. Use web_search to answer the query and include useful source URLs.',
                messages: [
                  {
                    role: 'user',
                    content: `Perform a web search for: ${webSearchParams.query}`,
                  },
                ],
                tools: [
                  {
                    type: 'web_search_20250305',
                    name: 'web_search',
                    max_uses: webSearchParams.maxUses ?? 5,
                    ...(webSearchParams.allowedDomains
                      ? { allowed_domains: webSearchParams.allowedDomains }
                      : {}),
                    ...(webSearchParams.blockedDomains
                      ? { blocked_domains: webSearchParams.blockedDomains }
                      : {}),
                  },
                ] as never,
              },
              {
                signal: webSearchParams.signal,
              },
            )

            return {
              text: formatWebSearchBlocks(response.content as unknown[]),
            }
          },
        }
      : {}),
  }
}
