import type { Interface } from 'node:readline/promises'

import { getConfig, type LightClawConfig } from './config.js'
import { streamChat } from './api.js'
import { runHook } from './hooks/index.js'
import { extractMemories } from './memory/extract.js'
import {
  collectAssistantText,
  createAssistantMessage,
  createUserMessage,
  getLastUuid,
  toApiMessages,
} from './messages.js'
import { buildSystemPromptTemplate, renderSystemPrompt } from './prompt.js'
import { modelFor } from './provider/index.js'
import { requestPermission } from './permission/index.js'
import {
  addUsage,
  getAbortController,
  getCwd,
  getLastExtractedAt,
  getMemoryDir,
  getSessionId,
  getTodos,
  incrementCompactionCount,
  registerBackgroundTask,
  setLastExtractedAt,
} from './state.js'
import { compactConversation } from './session/compact.js'
import { updateMetaLastExtractedAt } from './session/storage.js'
import { findToolByName, toolToAPISchema, type Tool } from './tool.js'
import { estimateMessagesTokens } from './token-estimate.js'
import type { Message, ToolExecutionEvent, UserToolResultBlock } from './types.js'

type QueryParams = {
  messages: Message[]
  tools: Tool[]
  config?: LightClawConfig
  maxTurns?: number
  onTextDelta?(text: string): void
  onToolUse?(event: { name: string; input: Record<string, unknown> }): void
  onToolResult?(event: ToolExecutionEvent): void
  onCompactStart?(): void
  onCompactEnd?(result: { removedCount: number; summaryTokens: number }): void
  onCompactError?(message: string): void
  isSubagent?: boolean
  isInteractive?: boolean
  rl?: Interface
  systemPrompt?: string
}

export async function query(params: QueryParams): Promise<{
  messages: Message[]
  lastAssistantText: string
  stopReason: string | null
  didCompact: boolean
}> {
  const config = params.config ?? getConfig()
  const maxTurns = params.maxTurns ?? 20
  const messages = [...params.messages]
  let lastAssistantText = ''
  let stopReason: string | null = null
  let didCompact = false

  const scheduleMemoryExtraction = (snapshot: Message[]) => {
    if (params.isSubagent || !config.autoMemory || stopReason !== 'end_turn') {
      return
    }

    const lastExtractedAt = getLastExtractedAt()
    const task = extractMemories({
      messages: snapshot,
      lastExtractedAt,
      memoryDir: getMemoryDir(),
      config,
    })
      .then(async result => {
        if (result.lastExtractedAt <= lastExtractedAt) {
          return
        }

        setLastExtractedAt(result.lastExtractedAt)
        await updateMetaLastExtractedAt(getSessionId(), result.lastExtractedAt)
      })
      .catch(error => {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[memory] ${message}`)
      })

    registerBackgroundTask(task)
  }

  const maybeAutoCompact = async () => {
    if (params.isSubagent || !config.autoCompact) {
      return
    }

    const totalTokens = estimateMessagesTokens(messages)
    const threshold = config.contextWindow * config.compactThresholdRatio
    if (totalTokens <= threshold) {
      return
    }

    params.onCompactStart?.()
    try {
      const result = await compactConversation({
        messages,
        keepRecent: config.compactKeepRecent,
        config,
      })

      if (result.removedCount === 0) {
        return
      }

      messages.splice(0, messages.length, ...result.messages)
      addUsage(result.usage)
      incrementCompactionCount()
      didCompact = true
      params.onCompactEnd?.({
        removedCount: result.removedCount,
        summaryTokens: result.summaryTokens,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      params.onCompactError?.(message)
    }
  }

  const systemPromptTemplate = params.systemPrompt
    ? null
    : await buildSystemPromptTemplate(params.tools, getCwd(), {
        autoMemory: config.autoMemory,
        config,
      })

  const beforeQueryResult = await runHook('beforeQuery', {
    sessionId: getSessionId(),
    input: getLastUserText(messages),
    messageCount: messages.length,
  })
  if (beforeQueryResult?.replacementInput !== undefined) {
    replaceLastUserText(messages, beforeQueryResult.replacementInput)
  }
  if (beforeQueryResult?.abort) {
    await runHook('afterQuery', {
      sessionId: getSessionId(),
      usage: { input: 0, output: 0 },
      abortReason: beforeQueryResult.abort.reason,
      messageCount: messages.length,
    })
    return {
      messages,
      lastAssistantText: '',
      stopReason: 'hook_abort',
      didCompact,
    }
  }

  for (let turn = 0; turn < maxTurns; turn += 1) {
    const systemPrompt =
      params.systemPrompt ??
      renderSystemPrompt(systemPromptTemplate!, getTodos())
    let stopEvent:
      | Extract<Awaited<ReturnType<typeof streamChat>> extends AsyncGenerator<infer T> ? T : never, { type: 'stop' }>
      | undefined

    for await (const event of streamChat({
      config,
      model: modelFor('main', config),
      messages: toApiMessages(messages),
      system: systemPrompt,
      tools: params.tools.map(toolToAPISchema),
      signal: getAbortController().signal,
    })) {
      if (event.type === 'text') {
        params.onTextDelta?.(event.text)
        continue
      }

      if (event.type === 'tool_use') {
        params.onToolUse?.({ name: event.name, input: event.input })
        continue
      }

      stopEvent = event
    }

    if (!stopEvent) {
      throw new Error('Model stream ended without a stop event.')
    }

    addUsage(stopEvent.usage)
    stopReason = stopEvent.stopReason
    lastAssistantText = collectAssistantText(stopEvent.content)
    messages.push(
      createAssistantMessage({
        content: stopEvent.content,
        stopReason: stopEvent.stopReason,
        usage: stopEvent.usage,
        parentUuid: getLastUuid(messages),
      }),
    )

    const toolUses = stopEvent.content.filter(
      (block): block is Extract<typeof block, { type: 'tool_use' }> =>
        block.type === 'tool_use',
    )

    if (toolUses.length === 0) {
      const extractionSnapshot = [...messages]
      await maybeAutoCompact()
      scheduleMemoryExtraction(extractionSnapshot)
      await runHook('afterQuery', {
        sessionId: getSessionId(),
        finalText: lastAssistantText,
        usage: {
          input: stopEvent.usage.input_tokens ?? 0,
          output: stopEvent.usage.output_tokens ?? 0,
        },
        messageCount: messages.length,
      })
      return {
        messages,
        lastAssistantText,
        stopReason,
        didCompact,
      }
    }

    const toolResults: UserToolResultBlock[] = []
    for (const toolUse of toolUses) {
      const tool = findToolByName(params.tools, toolUse.name)
      if (!tool) {
        const content = `Unknown tool: ${toolUse.name}`
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content,
          is_error: true,
        })
        params.onToolResult?.({
          toolName: toolUse.name,
          isError: true,
          content,
        })
        continue
      }

      const parsedInput = parseToolInput(tool, toolUse.input)
      if (!parsedInput.ok) {
        const content = `Invalid input for ${toolUse.name}: ${parsedInput.error}`
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content,
          is_error: true,
        })
        params.onToolResult?.({
          toolName: toolUse.name,
          isError: true,
          content,
        })
        continue
      }

      const callId = toolUse.id
      let effectiveInput = parsedInput.data
      try {
        const hookDecision = await runHook('beforeToolCall', {
          sessionId: getSessionId(),
          callId,
          toolName: tool.name,
          source: tool.source,
          mcpServer: tool.mcpServer,
          input: effectiveInput,
        })

        if (hookDecision?.replacementInput !== undefined) {
          effectiveInput = hookDecision.replacementInput
        }

        if (hookDecision?.replacementResult !== undefined) {
          const formatted = {
            type: 'tool_result' as const,
            tool_use_id: toolUse.id,
            content: hookDecision.replacementResult,
          }
          toolResults.push(formatted)
          params.onToolResult?.({
            toolName: toolUse.name,
            isError: false,
            content: formatted.content,
          })
          continue
        }

        if (hookDecision?.decision === 'deny') {
          const content = hookDecision.reason ?? `Tool denied by hook: ${tool.name}`
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content,
            is_error: true,
          })
          params.onToolResult?.({
            toolName: toolUse.name,
            isError: true,
            content,
          })
          continue
        }

        const decision = await requestPermission({
          tool,
          toolInput: effectiveInput,
          ctx: {
            isInteractive: Boolean(params.isInteractive && params.rl && !params.isSubagent),
            isSubagent: Boolean(params.isSubagent),
            signal: getAbortController().signal,
          },
          rl: params.rl,
        })

        if (decision.behavior === 'deny') {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: decision.reason,
            is_error: true,
          })
          params.onToolResult?.({
            toolName: toolUse.name,
            isError: true,
            content: decision.reason,
          })
          continue
        }

        const start = Date.now()
        const result = await tool.call(effectiveInput, {
          cwd: getCwd(),
          abortSignal: getAbortController().signal,
        })
        const formatted = tool.formatResult(
          result.output,
          toolUse.id,
          result.isError,
        )
        const afterTool = await runHook('afterToolCall', {
          sessionId: getSessionId(),
          callId,
          toolName: tool.name,
          source: tool.source,
          mcpServer: tool.mcpServer,
          input: effectiveInput,
          result: formatted.content,
          durationMs: Date.now() - start,
          ...(formatted.is_error ? { error: formatted.content } : {}),
        })
        if (afterTool?.replacementResult !== undefined) {
          formatted.content = afterTool.replacementResult
        }
        toolResults.push(formatted)
        params.onToolResult?.({
          toolName: toolUse.name,
          isError: Boolean(formatted.is_error),
          content: formatted.content,
        })
      } catch (error) {
        const content = error instanceof Error ? error.message : String(error)
        await runHook('afterToolCall', {
          sessionId: getSessionId(),
          callId,
          toolName: tool.name,
          source: tool.source,
          mcpServer: tool.mcpServer,
          input: effectiveInput,
          result: content,
          durationMs: 0,
          error: content,
        })
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content,
          is_error: true,
        })
        params.onToolResult?.({
          toolName: toolUse.name,
          isError: true,
          content,
        })
      }
    }

    messages.push(createUserMessage(toolResults, getLastUuid(messages)))
    await maybeAutoCompact()
  }

  throw new Error(`Exceeded maximum tool turns (${maxTurns}).`)
}

function getLastUserText(messages: Message[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.type === 'user' && typeof message.message.content === 'string') {
      return message.message.content
    }
  }

  return ''
}

function replaceLastUserText(messages: Message[], next: string): void {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.type === 'user' && typeof message.message.content === 'string') {
      message.message.content = next
      return
    }
  }
}

function parseToolInput(
  tool: Tool,
  rawInput: Record<string, unknown>,
): { ok: true; data: unknown } | { ok: false; error: string } {
  if (tool.source === 'mcp') {
    return { ok: true, data: rawInput }
  }

  if (!tool.inputSchema) {
    return { ok: false, error: 'Tool has no input schema.' }
  }

  const parsed = tool.inputSchema.safeParse(rawInput)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.message }
  }

  return { ok: true, data: parsed.data }
}
