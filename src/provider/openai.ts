import OpenAI from 'openai'
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions'

import type { LightClawConfig } from '../config.js'
import type {
  AssistantContentBlock,
  StreamEvent,
  StreamStopEvent,
  UsageStats,
  UserToolResultBlock,
} from '../types.js'
import type { ApiMessage, Provider, StreamChatParams } from './types.js'

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

        if (block.type === 'tool_result' && typeof block.content === 'string') {
          return block.content
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
        const toolResults = message.content.filter(
          (block): block is UserToolResultBlock =>
            isRecord(block) && block.type === 'tool_result',
        )
        if (toolResults.length > 0) {
          for (const block of toolResults) {
            converted.push({
              role: 'tool',
              tool_call_id: block.tool_use_id,
              content: block.content,
            })
          }
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
      parameters: tool.input_schema as Record<string, unknown>,
    },
  }))
}

function mapUsage(usage: unknown): UsageStats {
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
  return result
}

export function createOpenAIProvider(config: LightClawConfig): Provider {
  const openaiConfig = config.providerOptions.openai
  const client = new OpenAI({
    apiKey: openaiConfig?.apiKey,
    ...(openaiConfig?.baseUrl ? { baseURL: openaiConfig.baseUrl } : {}),
  })

  return {
    name: 'openai',
    capabilities: {
      serverTools: {
        webSearch: false,
      },
      promptCaching: false,
    },
    async *streamChat(params: StreamChatParams): AsyncGenerator<StreamEvent> {
      const pendingTools = new Map<number, PendingToolCall>()
      let text = ''
      let usage: UsageStats = {}
      let finishReason: string | null = null

      const stream = await client.chat.completions.create({
        model: params.model,
        messages: convertMessages(params.system, params.messages),
        tools: params.tools.length > 0 ? convertTools(params.tools) : undefined,
        max_tokens: params.maxTokens ?? 8192,
        stream: true,
        stream_options: {
          include_usage: true,
        },
      }, {
        signal: params.signal,
      })

      for await (const chunk of stream) {
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
        if (typeof delta.content === 'string' && delta.content.length > 0) {
          text += delta.content
          yield {
            type: 'text',
            text: delta.content,
          }
        }

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
  }
}
