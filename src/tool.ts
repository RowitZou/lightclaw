import { z } from 'zod'
import { toJSONSchema } from 'zod/v4'

import type { Provider } from './provider/types.js'
import type { RiskLevel } from './permission/types.js'
import type { Runtime } from './runtime/index.js'
import type { UserToolResultBlock } from './types.js'

export type ToolCallContext = {
  cwd: string
  abortSignal: AbortSignal
  runtime: Runtime
}

export type ToolCallResult<TOutput> = {
  output: TOutput
  isError?: boolean
}

export type Tool<TInput = unknown, TOutput = unknown> = {
  name: string
  description: string
  source: 'builtin' | 'mcp'
  mcpServer?: string
  mcpToolName?: string
  inputSchema?: z.ZodType<TInput>
  inputJSONSchema?: Record<string, unknown>
  riskLevel: RiskLevel
  isEnabled?(provider: Provider): boolean
  call(input: TInput, context: ToolCallContext): Promise<ToolCallResult<TOutput>>
  formatResult(
    output: TOutput,
    toolUseId: string,
    isError?: boolean,
  ): UserToolResultBlock
}

export function buildTool<TInput, TOutput>(input: {
  name: string
  description: string
  inputSchema: z.ZodType<TInput>
  riskLevel: RiskLevel
  isEnabled?(provider: Provider): boolean
  call(input: TInput, context: ToolCallContext): Promise<ToolCallResult<TOutput>>
  formatResult?: (
    output: TOutput,
    toolUseId: string,
    isError?: boolean,
  ) => UserToolResultBlock
}): Tool<TInput, TOutput> {
  return {
    source: 'builtin',
    ...input,
    formatResult:
      input.formatResult ??
      ((output, toolUseId, isError) => ({
        type: 'tool_result',
        tool_use_id: toolUseId,
        content:
          typeof output === 'string'
            ? output
            : JSON.stringify(output, null, 2),
        ...(isError ? { is_error: true } : {}),
      })),
  }
}

export function toolToAPISchema(tool: Tool): {
  name: string
  description: string
  input_schema: Record<string, unknown>
} {
  const inputSchema = tool.inputJSONSchema ??
    (tool.inputSchema
      ? toJSONSchema(tool.inputSchema) as Record<string, unknown>
      : { type: 'object', properties: {} })

  return {
    name: tool.name,
    description: tool.description,
    input_schema: inputSchema,
  }
}

export function findToolByName(tools: Tool[], name: string): Tool | undefined {
  return tools.find(tool => tool.name === name)
}
