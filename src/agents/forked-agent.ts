/**
 * Forked-Agent runner: a background or user-visible agent that reuses the
 * main agent's prompt/cache-safe prefix and runs under a function-based tool
 * gate. It is the shared infrastructure for AgentTool and background memory
 * extraction.
 *
 * Future consumers can reuse the same runner for autoDream, prompt coaching,
 * confidence rating, or skill self-authoring by supplying a task-specific
 * prompt and canUseTool gate.
 */

import { createUserMessage, getLastUuid } from '../messages.js'
import { query } from '../query.js'
import { getCurrentSessionContext, runWithSessionContext } from '../session-context.js'
import type { CanUseToolFn } from '../tool.js'
import type {
  AssistantMessage,
  AssistantToolUseBlock,
  Message,
  UsageStats,
  UserContentBlock,
  UserMessage,
  UserToolResultBlock,
} from '../types.js'
import type { CacheSafeParams } from './cache-safe-params.js'

// Byte-identical across all sibling forks so parallel AgentTool dispatches
// cache the parent prefix + assistant tool_use turn together. Mirrors Claude
// Code's `FORK_PLACEHOLDER_RESULT` in src/tools/AgentTool/forkSubagent.ts.
const FORK_PLACEHOLDER_RESULT = 'Fork started — processing in background'

export type ForkedAgentParams = {
  /**
   * The directive for this fork. Wrapped into a single user message at the end
   * of the cache-safe prefix; if the prefix's last message is an assistant
   * turn with pending tool_use blocks (i.e. AgentTool was dispatched mid-turn
   * in the parent loop), placeholder `tool_result` blocks are prepended to
   * the same user message so the API sees a valid alternating sequence.
   */
  promptText: string
  cacheSafeParams: CacheSafeParams
  canUseTool: CanUseToolFn
  // Optional cap on tool-use turns for this fork. Memory extraction passes a
  // small explicit value (intentional short task); subagent invocations leave
  // it undefined so query() falls back to config.maxTurns / no cap.
  maxTurns?: number
  label: string
  signal?: AbortSignal
}

export type ForkedAgentResult = {
  finalText: string
  stopReason: string | null
  usage: UsageStats
}

function pendingToolUseBlocks(message: AssistantMessage): AssistantToolUseBlock[] {
  return message.message.content.filter(
    (block): block is AssistantToolUseBlock => block.type === 'tool_use',
  )
}

function buildPromptMessage(prefix: Message[], promptText: string): UserMessage {
  const last = prefix[prefix.length - 1]
  const placeholders: UserToolResultBlock[] =
    last?.type === 'assistant'
      ? pendingToolUseBlocks(last).map(block => ({
          type: 'tool_result' as const,
          tool_use_id: block.id,
          content: FORK_PLACEHOLDER_RESULT,
          is_error: false,
        }))
      : []

  if (placeholders.length === 0) {
    return createUserMessage(promptText, getLastUuid(prefix))
  }

  const content: UserContentBlock[] = [
    ...placeholders,
    { type: 'text', text: promptText },
  ]
  return createUserMessage(content, getLastUuid(prefix))
}

export async function runForkedAgent(
  params: ForkedAgentParams,
): Promise<ForkedAgentResult> {
  const cacheSafeParams = params.cacheSafeParams
  const prefix = cacheSafeParams.forkContextMessages
  const promptMessage = buildPromptMessage(prefix, params.promptText)
  const messages = [...prefix, promptMessage]

  const run = () => query({
    messages,
    tools: cacheSafeParams.tools,
    config: cacheSafeParams.config,
    maxTurns: params.maxTurns,
    systemPrompt: cacheSafeParams.systemPrompt,
    mode: 'subagent',
    canUseTool: params.canUseTool,
    cacheBreakpointMessageIndex:
      prefix.length > 0 ? prefix.length - 1 : undefined,
    signal: params.signal,
    subagentLabel: params.label,
  })
  const currentCtx = getCurrentSessionContext()
  const result = currentCtx
    ? await runWithSessionContext({
        ...currentCtx,
        discoveredTools: new Set(),
      }, run)
    : await run()

  return {
    finalText: result.assistantText,
    stopReason: result.stopReason,
    usage: result.usage,
  }
}
