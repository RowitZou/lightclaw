import { runHook } from './hooks/index.js'
import { requestPermission } from './permission/index.js'
import { getCurrentSessionContext } from './session-context.js'
import {
  getCwd,
  getRuntime,
  getSessionId,
} from './state.js'
import { findDeferredTool } from './tools/deferred-loading.js'
import { markDiscovered } from './tools/discovered-tools.js'
import { isDeferredTool } from './tools/is-deferred.js'
import {
  findToolByName,
  type CanUseToolFn,
  type Tool,
  type ToolCallContext,
} from './tool.js'
import type {
  AssistantContentBlock,
  AssistantToolUseBlock,
  ToolExecutionEvent,
  UserToolResultBlock,
} from './types.js'
import { toolResultContentToText } from './types.js'
import type { LightClawConfig } from './config.js'
import type { RoleKind } from './agents/types.js'
import type { WakeNotifyResult } from './background-task/types.js'

export type ToolUseBlock = Extract<AssistantContentBlock, { type: 'tool_use' }>

export type DispatchContext = {
  tools: Tool[]
  allTools: Tool[]
  deferredTools: Tool[]
  roleKind: RoleKind
  permissionApprover?: Parameters<typeof requestPermission>[0]['ctx']['permissionApprover']
  onToolResult?(event: ToolExecutionEvent): void
  maxToolOutputBytes: number
  config: LightClawConfig
  canUseTool?: CanUseToolFn
  signal: AbortSignal
  wakeNotifications?: WakeNotifyResult[]
  mainTurnRouting?: ToolCallContext['mainTurnRouting']
}

export async function dispatchToolCall(
  toolUse: ToolUseBlock,
  ctx: DispatchContext,
): Promise<UserToolResultBlock> {
  const tool = findToolByName(ctx.tools, toolUse.name)
  if (!tool) {
    const deferredTool = findDeferredTool(ctx.allTools, toolUse.name)
    if (deferredTool) {
      return reportToolResult(
        ctx,
        toolUse,
        `Tool '${toolUse.name}' is deferred and not yet loaded. Call ToolSearch({query: "select:${toolUse.name}"}) to load its schema, then re-issue this tool call on your next turn.`,
        true,
      )
    }
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

    if (hookDecision?.decision === 'deny') {
      const content = hookDecision.reason ?? `Tool denied by hook: ${tool.name}`
      return reportToolResult(ctx, toolUse, content, true)
    }

    if (hookDecision?.replacementResult !== undefined) {
      return reportToolResult(ctx, toolUse, hookDecision.replacementResult, false)
    }

    if (ctx.canUseTool) {
      const gate = await ctx.canUseTool(tool, effectiveInput)
      if (gate.behavior === 'deny') {
        return reportToolResult(ctx, toolUse, gate.reason, true)
      }
    }

    const sessionCtx = getCurrentSessionContext()
    const decision = await requestPermission({
      tool,
      toolInput: effectiveInput,
      ctx: {
        isSubagent: ctx.roleKind !== 'orchestrator',
        signal: ctx.signal,
        permissionApprover: ctx.permissionApprover,
        isBackgroundTask: sessionCtx?.isBackgroundTask,
        taskAllowedTools: sessionCtx?.taskAllowedTools,
        onPermissionDenial: sessionCtx?.onPermissionDenial,
      },
    })

    if (decision.behavior === 'deny') {
      return reportToolResult(ctx, toolUse, decision.reason, true)
    }

    if (tool.domain === 'environment') {
      const runtime = getRuntime()
      const availability = await runtime.isAvailable()
      if (!availability.ok) {
        const isFatal = !availability.retryable
        const body = availability.retryable
          ? `${availability.userMessage}\n\n[runtime: ${availability.reason}, retryable]`
          : availability.userMessage
        return reportToolResult(ctx, toolUse, body, isFatal)
      }
    }

    if (isDeferredTool(tool)) {
      const current = getCurrentSessionContext()
      if (current && current.discoveredTools.has(tool.name)) {
        markDiscovered(
          current.discoveredTools,
          tool.name,
          current.turnCounter,
          ctx.config.tools.discoveredToolsMaxSize,
        )
      }
    }

    const start = Date.now()
    const result = await tool.call(effectiveInput, {
      cwd: getCwd(),
      abortSignal: ctx.signal,
      runtime: getRuntime(),
      mainTurnRouting: ctx.mainTurnRouting,
      canUseTool: ctx.canUseTool,
      wakeNotifications: ctx.wakeNotifications,
      deferredTools: ctx.deferredTools,
      discoverTool(name) {
        const current = getCurrentSessionContext()
        if (!current) return
        markDiscovered(
          current.discoveredTools,
          name,
          current.turnCounter,
          ctx.config.tools.discoveredToolsMaxSize,
        )
      },
    })
    const formatted = tool.formatResult(result.output, toolUse.id, result.isError)

    const formattedTextView = toolResultContentToText(formatted.content)
    const afterTool = await runHook('afterToolCall', {
      sessionId: getSessionId(),
      callId,
      toolName: tool.name,
      source: tool.source,
      mcpServer: tool.mcpServer,
      input: effectiveInput,
      result: formattedTextView,
      durationMs: Date.now() - start,
      ...(formatted.is_error ? { error: formattedTextView } : {}),
    })
    if (afterTool?.replacementResult !== undefined) {
      formatted.content = afterTool.replacementResult
    }

    if (typeof formatted.content === 'string') {
      formatted.content = snipContent(formatted.content, ctx.maxToolOutputBytes)
    }

    ctx.onToolResult?.({
      toolName: toolUse.name,
      isError: Boolean(formatted.is_error),
      content: toolResultContentToText(formatted.content),
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
  const snipped = snipContent(content, ctx.maxToolOutputBytes)
  ctx.onToolResult?.({
    toolName: toolUse.name,
    isError,
    content: snipped,
  })
  return {
    type: 'tool_result',
    tool_use_id: toolUse.id,
    content: snipped,
    ...(isError ? { is_error: true } : {}),
  }
}

function snipContent(content: string, maxBytes: number): string {
  const total = Buffer.byteLength(content, 'utf8')
  if (total <= maxBytes) {
    return content
  }
  const marker = `\n\n... [snipped ${total - maxBytes} bytes from middle of ${total} total] ...\n\n`
  const markerBytes = Buffer.byteLength(marker, 'utf8')
  const usable = Math.max(0, maxBytes - markerBytes)
  if (usable === 0) {
    return marker.trim()
  }
  const head = Math.floor(usable / 2)
  const tail = usable - head
  const buf = Buffer.from(content, 'utf8')
  return `${buf.subarray(0, head).toString('utf8')}${marker}${buf.subarray(buf.length - tail).toString('utf8')}`
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
