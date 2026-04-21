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
        input:
          block.input.trim().length === 0
            ? {}
            : (JSON.parse(block.input) as Record<string, unknown>),
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
        system: params.system,
        messages: params.messages as never,
        tools: params.tools as never,
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

      for await (const part of stream as AsyncIterable<unknown>) {
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

            const input =
              contentBlock.input.trim().length === 0
                ? {}
                : (JSON.parse(contentBlock.input) as Record<string, unknown>)
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

      const stopEvent: StreamStopEvent = {
        type: 'stop',
        stopReason,
        usage,
        content: finalizeContentBlocks(contentBlocks),
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
