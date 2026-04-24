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
import type {
  AssistantContentBlock,
  Message,
  ToolExecutionEvent,
  UserToolResultBlock,
} from './types.js'

/**
 * QueryMode selects orchestration behavior that differs between the REPL
 * (interactive), AgentTool subagents (subagent), and channel daemons like
 * feishu (channel). It drives whether auto-compact / auto-memory run and
 * whether the permission layer may invoke an interactive REPL prompt.
 *
 * | mode        | autoCompact | autoMemory | REPL prompt |
 * |-------------|:-----------:|:----------:|:-----------:|
 * | interactive |      ✓      |     ✓      |  ✓ (if rl)  |
 * | subagent    |      ✗      |     ✗      |      ✗      |
 * | channel     |      ✓      |     ✓      |      ✗      |
 */
export type QueryMode = 'interactive' | 'subagent' | 'channel'

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
  /** Defaults to 'interactive'. */
  mode?: QueryMode
  rl?: Interface
  /** Replaces the default system prompt entirely (used by subagents). */
  systemPrompt?: string
  /** Prepended to the default system prompt when provided (used by channels). */
  channelContext?: string
}

type ToolUseBlock = Extract<AssistantContentBlock, { type: 'tool_use' }>

type DispatchContext = {
  tools: Tool[]
  mode: QueryMode
  rl?: Interface
  onToolResult?(event: ToolExecutionEvent): void
}

export async function query(params: QueryParams): Promise<{
  messages: Message[]
  lastAssistantText: string
  stopReason: string | null
  didCompact: boolean
}> {
  const config = params.config ?? getConfig()
  const maxTurns = params.maxTurns ?? 20
  const mode: QueryMode = params.mode ?? 'interactive'
  const messages = [...params.messages]
  let lastAssistantText = ''
  let stopReason: string | null = null
  let didCompact = false

  const scheduleMemoryExtraction = (snapshot: Message[]) => {
    if (mode === 'subagent' || !config.autoMemory || stopReason !== 'end_turn') {
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
    if (mode === 'subagent' || !config.autoCompact) {
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

  const renderEffectiveSystemPrompt = (): string => {
    if (params.systemPrompt) {
      return params.systemPrompt
    }
    const rendered = renderSystemPrompt(systemPromptTemplate!, getTodos())
    return params.channelContext
      ? `${params.channelContext}\n\n${rendered}`
      : rendered
  }

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

  const dispatchCtx: DispatchContext = {
    tools: params.tools,
    mode,
    rl: params.rl,
    onToolResult: params.onToolResult,
  }

  for (let turn = 0; turn < maxTurns; turn += 1) {
    const systemPrompt = renderEffectiveSystemPrompt()
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
      (block): block is ToolUseBlock => block.type === 'tool_use',
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
      const result = await dispatchToolCall(toolUse, dispatchCtx)
      toolResults.push(result)
    }

    messages.push(createUserMessage(toolResults, getLastUuid(messages)))
    await maybeAutoCompact()
  }

  throw new Error(`Exceeded maximum tool turns (${maxTurns}).`)
}

async function dispatchToolCall(
  toolUse: ToolUseBlock,
  ctx: DispatchContext,
): Promise<UserToolResultBlock> {
  const tool = findToolByName(ctx.tools, toolUse.name)
  if (!tool) {
    return reportToolResult(ctx, toolUse, `Unknown tool: ${toolUse.name}`, true)
  }

  const parsedInput = parseToolInput(tool, toolUse.input)
  if (!parsedInput.ok) {
    return reportToolResult(
      ctx,
      toolUse,
      `Invalid input for ${toolUse.name}: ${parsedInput.error}`,
      true,
    )
  }

  let effectiveInput = parsedInput.data
  const callId = toolUse.id

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

    // decision: 'deny' takes precedence over replacementResult.
    // A deny + replacementResult combination is treated as deny (is_error: true)
    // so a hook cannot silently convert a deny into a non-error result.
    if (hookDecision?.decision === 'deny') {
      const content = hookDecision.reason ?? `Tool denied by hook: ${tool.name}`
      return reportToolResult(ctx, toolUse, content, true)
    }

    if (hookDecision?.replacementResult !== undefined) {
      return reportToolResult(ctx, toolUse, hookDecision.replacementResult, false)
    }

    const decision = await requestPermission({
      tool,
      toolInput: effectiveInput,
      ctx: {
        isInteractive: ctx.mode === 'interactive' && ctx.rl !== undefined,
        isSubagent: ctx.mode === 'subagent',
        signal: getAbortController().signal,
      },
      rl: ctx.rl,
    })

    if (decision.behavior === 'deny') {
      return reportToolResult(ctx, toolUse, decision.reason, true)
    }

    const start = Date.now()
    const result = await tool.call(effectiveInput, {
      cwd: getCwd(),
      abortSignal: getAbortController().signal,
    })
    const formatted = tool.formatResult(result.output, toolUse.id, result.isError)

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

    ctx.onToolResult?.({
      toolName: toolUse.name,
      isError: Boolean(formatted.is_error),
      content: formatted.content,
    })
    return formatted
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
    return reportToolResult(ctx, toolUse, content, true)
  }
}

function reportToolResult(
  ctx: DispatchContext,
  toolUse: ToolUseBlock,
  content: string,
  isError: boolean,
): UserToolResultBlock {
  ctx.onToolResult?.({
    toolName: toolUse.name,
    isError,
    content,
  })
  return {
    type: 'tool_result',
    tool_use_id: toolUse.id,
    content,
    ...(isError ? { is_error: true } : {}),
  }
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
