import { z } from 'zod'
import { toJSONSchema } from 'zod/v4'

import type { Provider } from './provider/types.js'
import type { PermissionRuleValue, RiskLevel } from './permission/types.js'
import type { Runtime } from './runtime/index.js'
import type { UserToolResultBlock } from './types.js'
import type { ChannelKey } from './channel-types.js'
import type { ChainState } from './signal-bus/chain-state.js'
import type { LightClawConfig } from './config.js'

export type ToolCallContext = {
  cwd: string
  abortSignal: AbortSignal
  runtime: Runtime
  config?: LightClawConfig
  mainTurnRouting?: {
    provider: Provider
    schema: Provider['name']
    endpoint: string
    /** baseUrl of `endpoint`, populated alongside the endpoint alias so
     *  tools that read the capability cache can build a complete key.
     *  `undefined` when the endpoint relies on the provider SDK default. */
    endpointBaseUrl: string | undefined
    upstreamModel: string
  }
  canUseTool?: CanUseToolFn
  chainState?: ChainState
  deferredTools?: readonly Tool[]
  toolCallId?: string
  discoverTool?(name: string): void
}

export type CanUseToolDecision =
  | { behavior: 'allow' }
  | { behavior: 'deny'; reason: string }

export type CanUseToolFn = (
  tool: Tool,
  input: unknown,
) => Promise<CanUseToolDecision> | CanUseToolDecision

export type ToolCallResult<TOutput> = {
  output: TOutput
  isError?: boolean
}

export type ToolDomain = 'host' | 'environment'

export type Tool<TInput = unknown, TOutput = unknown> = {
  name: string
  description: string
  source: 'builtin' | 'mcp'
  domain: ToolDomain
  mcpServer?: string
  mcpToolName?: string
  inputSchema?: z.ZodType<TInput>
  inputJSONSchema?: Record<string, unknown>
  riskLevel: RiskLevel
  /**
   * When true, contiguous tool_uses for this tool can be dispatched in parallel
   * within a single agent turn. Defaults to false. Mark true for tools whose
   * effects are limited to host-domain reads (memory / session history) or
   * side-effect-free environment reads (Read / Glob / WebFetch). Never mark
   * writers, executors, or anything that mutates shared state.
   */
  concurrencySafe?: boolean
  /** Omitted means visible in every channel. */
  channelScope?: readonly ChannelKey[]
  /** Channel-only tools are hidden when no channel context exists. */
  channelOnly?: boolean
  /**
   * Internal-only tools are excluded from user-facing catalogs and ToolSearch.
   * They may be included explicitly for framework-managed internal roles.
   */
  internalOnly?: boolean
  /** Force this tool into the always-loaded set. */
  alwaysLoad?: boolean
  /** Force this tool into the deferred set; wins over alwaysLoad. */
  shouldDefer?: boolean
  /**
   * Optional keyword bag for ToolSearch matching. Keep this short and focused
   * on synonyms the model may query that are not obvious from the tool name.
   */
  searchHint?: string
  /**
   * One-line trigger summary rendered by the framework alongside the tool name
   * in `## Tool Catalog` (inline) and the deferred-tool `<system-reminder>`
   * (deferred). Symmetric with `Skill.whenToUse`. Lets the model decide when to
   * ToolSearch a deferred tool without first loading its full description.
   */
  whenToUse?: string
  isEnabled?(provider: Provider): boolean
  /**
   * Called when permission policy decides to ASK; the returned rules become
   * the scoped-approval menu (terminal numbered list / Feishu N-button card).
   * Order is precise → broad. Default fallback (when omitted) is a single
   * tool-wide allow rule, equivalent to the legacy `[a]` / `批准所有` button.
   */
  suggestPermissionRules?(input: TInput): PermissionRuleValue[]
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
  domain: ToolDomain
  inputSchema: z.ZodType<TInput>
  riskLevel: RiskLevel
  concurrencySafe?: boolean
  channelScope?: readonly ChannelKey[]
  channelOnly?: boolean
  internalOnly?: boolean
  alwaysLoad?: boolean
  shouldDefer?: boolean
  searchHint?: string
  whenToUse?: string
  isEnabled?(provider: Provider): boolean
  suggestPermissionRules?(input: TInput): PermissionRuleValue[]
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
