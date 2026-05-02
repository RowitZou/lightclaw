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

import { query } from '../query.js'
import type { Message, UsageStats } from '../types.js'
import type { LightClawConfig } from '../config.js'
import type { CanUseToolFn } from '../tool.js'
import type { CacheSafeParams } from './cache-safe-params.js'

export type ForkedAgentParams = {
  promptMessages: Message[]
  cacheSafeParams: CacheSafeParams
  canUseTool: CanUseToolFn
  maxTurns: number
  label: string
  skipTranscript?: boolean
  config?: LightClawConfig
  signal?: AbortSignal
}

export type ForkedAgentResult = {
  finalText: string
  stopReason: string | null
  usage: UsageStats
}

export async function runForkedAgent(
  params: ForkedAgentParams,
): Promise<ForkedAgentResult> {
  const cacheSafeParams = params.cacheSafeParams
  const messages = [
    ...cacheSafeParams.forkContextMessages,
    ...params.promptMessages,
  ]

  const result = await query({
    messages,
    tools: cacheSafeParams.tools,
    config: params.config ?? cacheSafeParams.config,
    maxTurns: params.maxTurns,
    systemPrompt: cacheSafeParams.systemPrompt,
    mode: 'subagent',
    canUseTool: params.canUseTool,
    cacheBreakpointMessageIndex:
      cacheSafeParams.forkContextMessages.length > 0
        ? cacheSafeParams.forkContextMessages.length - 1
        : undefined,
    signal: params.signal,
  })

  return {
    finalText: result.lastAssistantText,
    stopReason: result.stopReason,
    usage: result.usage,
  }
}
