import { getConfig, type LightClawConfig } from './config.js'
import { streamChat } from './api.js'
import {
  collectAssistantText,
  createAssistantMessage,
  createUserMessage,
  toApiMessages,
} from './messages.js'
import { buildSystemPrompt } from './prompt.js'
import { addUsage, getAbortController, getCwd } from './state.js'
import { findToolByName, toolToAPISchema, type Tool } from './tool.js'
import type { Message, ToolExecutionEvent, UserToolResultBlock } from './types.js'

type QueryParams = {
  messages: Message[]
  tools: Tool[]
  config?: LightClawConfig
  maxTurns?: number
  onTextDelta?(text: string): void
  onToolUse?(event: { name: string; input: Record<string, unknown> }): void
  onToolResult?(event: ToolExecutionEvent): void
}

export async function query(params: QueryParams): Promise<{
  messages: Message[]
  lastAssistantText: string
  stopReason: string | null
}> {
  const config = params.config ?? getConfig()
  const maxTurns = params.maxTurns ?? 8
  const messages = [...params.messages]
  let lastAssistantText = ''
  let stopReason: string | null = null

  for (let turn = 0; turn < maxTurns; turn += 1) {
    let stopEvent:
      | Extract<Awaited<ReturnType<typeof streamChat>> extends AsyncGenerator<infer T> ? T : never, { type: 'stop' }>
      | undefined

    for await (const event of streamChat({
      config,
      model: config.model,
      messages: toApiMessages(messages),
      system: buildSystemPrompt(params.tools, getCwd()),
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
      }),
    )

    const toolUses = stopEvent.content.filter(
      (block): block is Extract<typeof block, { type: 'tool_use' }> =>
        block.type === 'tool_use',
    )

    if (toolUses.length === 0) {
      return {
        messages,
        lastAssistantText,
        stopReason,
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

      const parsedInput = tool.inputSchema.safeParse(toolUse.input)
      if (!parsedInput.success) {
        const content = `Invalid input for ${toolUse.name}: ${parsedInput.error.message}`
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

      try {
        const result = await tool.call(parsedInput.data, {
          cwd: getCwd(),
          abortSignal: getAbortController().signal,
        })
        const formatted = tool.formatResult(
          result.output,
          toolUse.id,
          result.isError,
        )
        toolResults.push(formatted)
        params.onToolResult?.({
          toolName: toolUse.name,
          isError: Boolean(formatted.is_error),
          content: formatted.content,
        })
      } catch (error) {
        const content = error instanceof Error ? error.message : String(error)
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

    messages.push(createUserMessage(toolResults))
  }

  throw new Error(`Exceeded maximum tool turns (${maxTurns}).`)
}