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
import { buildProxyAwareFetch, buildProxyDispatcher } from './proxy.js'
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

export function createOpenAIProvider(endpoint: ApiKeyEndpoint): Provider {
  const proxyFetch = buildProxyAwareFetch(buildProxyDispatcher(endpoint.proxy))
  const client = new OpenAI({
    apiKey: endpoint.apiKey,
    ...(endpoint.baseUrl ? { baseURL: endpoint.baseUrl } : {}),
    ...(proxyFetch ? { fetch: proxyFetch } : {}),
  })

  return {
    name: 'openai',
    capabilities: {
      serverTools: {
        webSearch: false,
      },
      promptCaching: false,
      // OpenAI Responses API supports image input via image_url parts. PDF
      // input is supported on selected gpt-4o / gpt-5 generations via the
      // file input shape, but coverage is uneven across compat layers
      // (newapi proxy in particular may strip `file` content). Start at
      // 'unknown' for both and let the autopilot discover.
      attachments: {
        image: 'unknown',
        pdf: 'unknown',
        audio: false,
        video: false,
      },
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
    async describeImage(params) {
      const images = params.images ?? (params.image ? [params.image] : [])
      if (images.length === 0) {
        throw new Error('describeImage requires at least one image.')
      }
      const completion = await client.chat.completions.create({
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
      const transcription = await client.audio.transcriptions.create({
        file,
        model: params.model ?? 'whisper-1',
        ...(params.prompt ? { prompt: params.prompt } : {}),
        ...(params.language ? { language: params.language } : {}),
      }, {
        signal: params.signal,
      })
      return {
        text: transcription.text,
        model: params.model ?? 'whisper-1',
      }
    },
  }
}
