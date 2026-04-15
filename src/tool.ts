import { z } from 'zod'
import { toJSONSchema } from 'zod/v4'

import type { UserToolResultBlock } from './types.js'

export type ToolCallContext = {
  cwd: string
  abortSignal: AbortSignal
}

export type ToolCallResult<TOutput> = {
  output: TOutput
  isError?: boolean
}

export type Tool<TInput = unknown, TOutput = unknown> = {
  name: string
  description: string
  inputSchema: z.ZodType<TInput>
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
  call(input: TInput, context: ToolCallContext): Promise<ToolCallResult<TOutput>>
  formatResult?: (
    output: TOutput,
    toolUseId: string,
    isError?: boolean,
  ) => UserToolResultBlock
}): Tool<TInput, TOutput> {
  return {
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
  return {
    name: tool.name,
    description: tool.description,
    input_schema: toJSONSchema(tool.inputSchema) as Record<string, unknown>,
  }
}

export function findToolByName(tools: Tool[], name: string): Tool | undefined {
  return tools.find(tool => tool.name === name)
}