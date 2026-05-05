import OpenAI from 'openai'
import type {
  ResponseCreateParamsStreaming,
  ResponseFunctionToolCallItem,
  ResponseInputItem,
  ResponseStreamEvent,
} from 'openai/resources/responses/responses'
import type { FunctionTool } from 'openai/resources/responses/responses'
import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from 'undici'

import { getCredentials } from '../auth/index.js'
import { CODEX_BACKEND_BASE_URL } from '../auth/codex/constants.js'
import type { OAuthEndpoint } from '../config.js'
import type {
  AssistantContentBlock,
  StreamEvent,
  StreamStopEvent,
  UsageStats,
  UserToolResultBlock,
} from '../types.js'
import type { ApiMessage, Provider, StreamChatParams } from './types.js'

// OpenAI Responses API provider, used with OAuth-sourced credentials. The
// canonical case is the Codex backend (chatgpt.com/backend-api/codex)
// behind a ChatGPT subscription token. The provider re-resolves
// credentials on every streamChat call so refreshes happen transparently.
//
// Proxy gotcha: Node's built-in fetch (used by the OpenAI SDK) does NOT
// honor http_proxy / https_proxy env vars. LightClaw runs inside a
// network that requires the corporate proxy to reach external hosts
// (chatgpt.com is external), so we wire an undici fetch + ProxyAgent
// per-client. Without this the SDK call hangs until its 10-minute
// timeout — exactly the symptom the first round of testing surfaced.

function defaultProxyDispatcher(): Dispatcher | undefined {
  const proxyUrl =
    process.env.https_proxy ??
    process.env.HTTPS_PROXY ??
    process.env.http_proxy ??
    process.env.HTTP_PROXY
  if (!proxyUrl) return undefined
  try {
    return new ProxyAgent(proxyUrl)
  } catch {
    return undefined
  }
}

function buildProxyAwareFetch(
  dispatcher: Dispatcher | undefined,
): typeof globalThis.fetch | undefined {
  if (!dispatcher) return undefined
  return ((url: string | URL | Request, init?: RequestInit) =>
    // undici.fetch is API-compatible with the global fetch; the dispatcher
    // field is the only undici extension we rely on here. The cast is the
    // standard way to bridge the two type spaces — safe in practice
    // because Node's fetch IS undici's fetch since Node 18.
    undiciFetch(url as never, {
      ...(init ?? {}),
      dispatcher,
    } as never) as unknown as Promise<Response>) as typeof globalThis.fetch
}
//
// The Responses API has a different shape from Chat Completions:
// - `instructions` carries the system prompt
// - `input` is an array of typed items (messages, function_call,
//   function_call_output) — there is no role:'tool' shape
// - tools are top-level type=function, not nested
// - streaming events are discriminated by `event.type` (response.*)
//
// The minimum feature set covered here: text streaming, function-call
// streaming, stop event with usage. Reasoning content / encrypted
// reasoning items / multi-modal input are not exposed yet — Iter 5
// observation will tell us what gpt-5-codex actually emits before we
// surface it.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function userContentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return String(content ?? '')
  return content
    .map(block => {
      if (!isRecord(block)) return ''
      if (block.type === 'text' && typeof block.text === 'string') {
        return block.text
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function userToolResults(content: unknown): UserToolResultBlock[] {
  if (!Array.isArray(content)) return []
  return content.filter(
    (block): block is UserToolResultBlock =>
      isRecord(block) && block.type === 'tool_result',
  )
}

/**
 * Convert LightClaw's API message array into Responses API input items.
 * `system` is hoisted to the top-level `instructions` field by the caller;
 * we only handle user / assistant messages here.
 */
export function convertMessagesToResponsesInput(
  messages: ApiMessage[],
): ResponseInputItem[] {
  const out: ResponseInputItem[] = []

  for (const message of messages) {
    if (message.role === 'user') {
      const toolResults = userToolResults(message.content)
      const text = userContentText(message.content)

      for (const block of toolResults) {
        out.push({
          type: 'function_call_output',
          call_id: block.tool_use_id,
          output: block.content,
        } as ResponseInputItem.FunctionCallOutput)
      }
      if (text.length > 0) {
        out.push({
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text }],
        } as ResponseInputItem.Message)
      }
      continue
    }

    // assistant
    const blocks = Array.isArray(message.content) ? message.content : []
    const text = blocks
      .filter(
        (block): block is AssistantContentBlock & { type: 'text' } =>
          isRecord(block) && block.type === 'text',
      )
      .map(block => block.text)
      .join('')
    const toolUses = blocks.filter(
      (block): block is AssistantContentBlock & { type: 'tool_use' } =>
        isRecord(block) && block.type === 'tool_use',
    )

    if (text.length > 0) {
      // Assistant text echoed back as an output_text item; the Responses
      // API expects the raw output shape on input.
      out.push({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }],
      } as unknown as ResponseInputItem)
    }
    for (const tu of toolUses) {
      out.push({
        type: 'function_call',
        call_id: tu.id,
        name: tu.name,
        arguments: JSON.stringify(tu.input ?? {}),
      } as ResponseFunctionToolCallItem as unknown as ResponseInputItem)
    }
  }

  return out
}

/** Convert LightClaw's tool list into Responses API function tools. */
export function convertToolsToResponsesShape(
  tools: StreamChatParams['tools'],
): FunctionTool[] {
  return tools.map(tool => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema as Record<string, unknown>,
    strict: false,
  }))
}

type PendingFunctionCall = {
  id: string
  name: string
  args: string
}

function mapResponsesUsage(usage: unknown): UsageStats {
  if (!isRecord(usage)) return {}
  const out: UsageStats = {}
  if (typeof usage.input_tokens === 'number') {
    out.input_tokens = usage.input_tokens
  }
  if (typeof usage.output_tokens === 'number') {
    out.output_tokens = usage.output_tokens
  }
  return out
}

export type OpenAIAuthProviderOptions = {
  /**
   * Override the auth provider name. Defaults to `'codex'` since v1 only
   * has Codex; future Copilot-OAuth schema would set this to `'copilot'`.
   */
  authProviderName?: string
}

export function createOpenAIAuthProvider(
  endpoint: OAuthEndpoint,
  opts: OpenAIAuthProviderOptions = {},
): Provider {
  const authName = opts.authProviderName ?? 'codex'
  const baseURL = endpoint.baseUrl ?? CODEX_BACKEND_BASE_URL

  return {
    name: 'openai-auth',
    capabilities: {
      serverTools: { webSearch: false },
      promptCaching: false,
    },
    async *streamChat(params: StreamChatParams): AsyncGenerator<StreamEvent> {
      const credentials = await getCredentials(authName)
      const proxiedFetch = buildProxyAwareFetch(defaultProxyDispatcher())
      const client = new OpenAI({
        apiKey: credentials.accessToken,
        baseURL,
        defaultHeaders: {
          'chatgpt-account-id': credentials.accountId,
        },
        ...(proxiedFetch ? { fetch: proxiedFetch } : {}),
      })

      const input = convertMessagesToResponsesInput(params.messages)
      const tools = convertToolsToResponsesShape(params.tools)

      const body: ResponseCreateParamsStreaming = {
        model: params.model,
        instructions: params.system,
        input,
        ...(tools.length > 0
          ? { tools, tool_choice: 'auto', parallel_tool_calls: true }
          : {}),
        stream: true,
        store: false,
      }

      const stream = await client.responses.create(body, {
        signal: params.signal,
      })

      const pending = new Map<string, PendingFunctionCall>()
      let textBuffer = ''
      let usage: UsageStats = {}
      let stopReason: string | null = null
      let toolUseIndex = 0

      for await (const event of stream as AsyncIterable<ResponseStreamEvent>) {
        switch (event.type) {
          case 'response.output_item.added': {
            const item = event.item as { type?: string; id?: string; call_id?: string; name?: string }
            if (item.type === 'function_call' && item.id) {
              pending.set(item.id, {
                id: item.call_id ?? item.id,
                name: item.name ?? '',
                args: '',
              })
            }
            break
          }
          case 'response.function_call_arguments.delta': {
            const ev = event as { item_id: string; delta: string }
            const slot = pending.get(ev.item_id)
            if (slot) {
              slot.args += ev.delta
            }
            break
          }
          case 'response.output_item.done': {
            const item = event.item as { id?: string; type?: string; name?: string; arguments?: string; call_id?: string }
            if (item.type === 'function_call' && item.id) {
              const slot = pending.get(item.id)
              if (slot) {
                if (item.arguments && slot.args.length === 0) {
                  slot.args = item.arguments
                }
                if (item.name && !slot.name) slot.name = item.name
                if (item.call_id) slot.id = item.call_id
                let parsedInput: Record<string, unknown> = {}
                if (slot.args.trim().length > 0) {
                  try {
                    parsedInput = JSON.parse(slot.args) as Record<string, unknown>
                  } catch {
                    // Leave parsedInput as {}; the model will see the
                    // mismatch via the resulting tool_result error.
                  }
                }
                yield {
                  type: 'tool_use',
                  id: slot.id,
                  name: slot.name,
                  input: parsedInput,
                  index: toolUseIndex++,
                }
                pending.delete(item.id)
              }
            }
            break
          }
          case 'response.output_text.delta': {
            const ev = event as { delta: string }
            if (ev.delta && ev.delta.length > 0) {
              textBuffer += ev.delta
              yield { type: 'text', text: ev.delta }
            }
            break
          }
          case 'response.completed': {
            const response = event.response as {
              status?: string
              incomplete_details?: { reason?: string } | null
              usage?: unknown
            }
            usage = mapResponsesUsage(response.usage)
            const finishReason = response.status ?? 'completed'
            const incompleteReason = response.incomplete_details?.reason
            if (finishReason === 'completed') {
              stopReason = 'end_turn'
            } else if (incompleteReason === 'max_output_tokens') {
              stopReason = 'max_tokens'
            } else if (finishReason === 'incomplete') {
              stopReason = 'max_tokens'
            } else {
              stopReason = 'end_turn'
            }
            break
          }
          case 'response.failed':
          case 'response.incomplete': {
            const response = event.response as { usage?: unknown }
            usage = mapResponsesUsage(response.usage)
            stopReason = event.type === 'response.failed' ? 'error' : 'max_tokens'
            break
          }
          case 'error': {
            const ev = event as { code?: string; message?: string }
            throw new Error(
              `OpenAI Responses API error${ev.code ? ` (${ev.code})` : ''}: ${ev.message ?? 'unknown'}`,
            )
          }
          default:
            // Reasoning summary / annotations / refusal / web_search etc.
            // Not exposed yet — observed via Iter 5 telemetry before
            // surfacing.
            break
        }
      }

      // pending function_calls without a corresponding output_item.done
      // (defensive — should not happen in normal flow).
      for (const [, slot] of pending) {
        let parsedInput: Record<string, unknown> = {}
        if (slot.args.trim().length > 0) {
          try {
            parsedInput = JSON.parse(slot.args) as Record<string, unknown>
          } catch {
            // ignore
          }
        }
        yield {
          type: 'tool_use',
          id: slot.id,
          name: slot.name,
          input: parsedInput,
          index: toolUseIndex++,
        }
      }

      const content: AssistantContentBlock[] = []
      if (textBuffer.length > 0) {
        content.push({ type: 'text', text: textBuffer })
      }
      // We don't reconstruct tool_use blocks into `content` here because
      // the agent loop builds AssistantContentBlocks from streaming events,
      // not the stop event's content array (mirrors openai.ts behavior).

      const stopEvent: StreamStopEvent = {
        type: 'stop',
        stopReason: stopReason ?? 'end_turn',
        usage,
        content,
      }
      yield stopEvent
    },
  }
}
