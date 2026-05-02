import Anthropic from '@anthropic-ai/sdk'

import type { LightClawConfig } from '../config.js'
import type {
  AssistantContentBlock,
  StreamEvent,
  StreamStopEvent,
  UsageStats,
} from '../types.js'
import type {
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

function cacheSystem(system: string): Array<Record<string, unknown>> {
  return [
    {
      type: 'text',
      text: system,
      cache_control: EPHEMERAL_CACHE,
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
    return content.map(block => isRecord(block) ? { ...block } : { type: 'text', text: String(block) })
  }
  return [{ type: 'text', text: String(content ?? '') }]
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
    if (!breakpoints.has(index)) {
      return message
    }
    return {
      ...message,
      content: cacheMessageContent(message.content),
    }
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

export function createAnthropicProvider(config: LightClawConfig): Provider {
  const anthropicConfig = config.providerOptions.anthropic
  const baseURL = anthropicConfig?.baseUrl
  const client = new Anthropic({
    apiKey: anthropicConfig?.apiKey ?? '',
    ...(baseURL ? { baseURL } : {}),
  })
  const webSearchSupported = !baseURL

  return {
    name: 'anthropic',
    capabilities: {
      serverTools: {
        webSearch: webSearchSupported,
      },
      promptCaching: true,
    },
    async *streamChat(params: StreamChatParams): AsyncGenerator<StreamEvent> {
      const stream = await client.messages.create({
        model: params.model,
        max_tokens: params.maxTokens ?? 8192,
        system: cacheSystem(params.system) as never,
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
