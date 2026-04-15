import Anthropic from '@anthropic-ai/sdk'

import type {
  AssistantContentBlock,
  StreamEvent,
  StreamStopEvent,
  UsageStats,
} from './types.js'
import type { LightClawConfig } from './config.js'

type StreamChatParams = {
  config: LightClawConfig
  model: string
  messages: Array<{ role: 'user' | 'assistant'; content: unknown }>
  system: string
  tools: Array<{ name: string; description: string; input_schema: object }>
  maxTokens?: number
  signal?: AbortSignal
}

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

let client: Anthropic | null = null
let clientKey = ''

function getClient(config: LightClawConfig): Anthropic {
  const nextKey = `${config.apiKey}:${config.baseUrl ?? ''}`
  if (!client || clientKey !== nextKey) {
    client = new Anthropic({
      apiKey: config.apiKey,
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
    })
    clientKey = nextKey
  }

  return client
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

export async function* streamChat(
  params: StreamChatParams,
): AsyncGenerator<StreamEvent> {
  const anthropic = getClient(params.config)
  const stream = await anthropic.messages.create({
    model: params.model,
    max_tokens: params.maxTokens ?? 2048,
    system: params.system,
    messages: params.messages as never,
    tools: params.tools as never,
    stream: true,
  }, {
    signal: params.signal,
  })

  const contentBlocks = new Map<number, AssistantContentBlock | PendingToolUseBlock>()
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
        const contentBlock = isRecord(part.content_block) ? part.content_block : undefined
        if (index < 0 || !contentBlock || typeof contentBlock.type !== 'string') {
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
        if (index < 0 || !delta || !contentBlock || typeof delta.type !== 'string') {
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

        if (delta.type === 'input_json_delta' && contentBlock.type === 'tool_use') {
          const partialJson = typeof delta.partial_json === 'string' ? delta.partial_json : ''
          contentBlock.input += partialJson
        }
        break
      }
      case 'content_block_stop': {
        const index = typeof part.index === 'number' ? part.index : -1
        const contentBlock = contentBlocks.get(index)
        if (index < 0 || !contentBlock || !isPendingToolUseBlock(contentBlock)) {
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
}