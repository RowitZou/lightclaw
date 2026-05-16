/**
 * Forked-Agent runner: a background or user-visible agent that reuses the
 * main agent's prompt/cache-safe prefix and runs under a function-based tool
 * gate. It is the shared infrastructure for AgentTool and background memory
 * extraction.
 *
 * Future consumers can reuse the same runner for autoDream, prompt coaching,
 * confidence rating, or skill self-authoring by supplying a Role plus a
 * task-specific prompt.
 */

import { randomUUID } from 'node:crypto'

import { createUserMessage, getLastUuid } from '../messages.js'
import { buildPromptForRole } from '../prompt.js'
import { query } from '../query.js'
import { getCurrentSessionContext, runWithSessionContext } from '../session-context.js'
import { getRuntime } from '../state.js'
import type { CanUseToolFn } from '../tool.js'
import { forkInvocationContext } from './invocation-context.js'
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
import type { Role } from './types.js'
import { deriveCanUseTool } from './role-tool-gate.js'
import { getForkTranscriptPath, persistForkTranscript } from './fork-transcript.js'

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
  role: Role
  currentRoleOverride?: Role
  canUseToolOverride?: CanUseToolFn
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
  forkTranscriptPath: string | null
  forkTranscriptPersisted: Promise<string | null>
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
  const systemPrompt = buildPromptForRole(params.role, {
    tools: cacheSafeParams.tools,
    environmentRoot: getRuntime().workspaceRoot,
  })
  const canUseTool = params.canUseToolOverride ?? deriveCanUseTool(params.role)
  const currentCtx = getCurrentSessionContext()
  const forkId = randomUUID().slice(0, 8)
  const forkTranscriptPath = currentCtx
    ? getForkTranscriptPath({
        sessionsDir: currentCtx.sessionsDir,
        parentSessionId: currentCtx.sessionId,
        roleAgentType: params.role.agentType,
        forkId,
      })
    : null

  const run = () => query({
    role: params.role,
    invocation: forkInvocationContext({
      systemPrompt,
      canUseTool,
      cacheBreakpointMessageIndex:
        prefix.length > 0 ? prefix.length - 1 : undefined,
      signal: params.signal,
      subagentLabel: params.label,
      currentRoleOverride: params.currentRoleOverride,
    }),
    messages,
    tools: cacheSafeParams.tools,
    config: cacheSafeParams.config,
    maxTurns: params.maxTurns,
  })
  // forkContextEndIndex marks where the inherited parent prefix
  // (cacheSafeParams.forkContextMessages + buildPromptMessage) ends and the
  // fork's own loop messages begin. Persisted on the meta line so per-role
  // extract can slice fork-own vs context cleanly without re-analyzing
  // unrelated parent DM content. See fork-transcript.ts header comment.
  const forkContextEndIndex = messages.length
  let messagesToPersist = messages
  let persistTask: Promise<string | null> | null = null
  try {
    const result = currentCtx
        ? await runWithSessionContext({
          ...currentCtx,
          currentRole: params.role,
          discoveredTools: new Map(),
          turnCounter: 0,
        }, run)
      : await run()
    messagesToPersist = result.messages
    if (forkTranscriptPath) {
      persistTask = persistForkTranscript(
        forkTranscriptPath,
        messagesToPersist,
        forkContextEndIndex,
      )
        .then(() => forkTranscriptPath)
        .catch(error => {
          const message = error instanceof Error ? error.message : String(error)
          process.stderr.write(`[fork-transcript] persist failed: ${message}\n`)
          return null
        })
    }

    return {
      finalText: result.assistantText,
      stopReason: result.stopReason,
      usage: result.usage,
      forkTranscriptPath,
      forkTranscriptPersisted: persistTask ?? Promise.resolve(null),
    }
  } finally {
    if (!persistTask && forkTranscriptPath) {
      persistTask = persistForkTranscript(
        forkTranscriptPath,
        messagesToPersist,
        forkContextEndIndex,
      )
        .then(() => forkTranscriptPath)
        .catch(error => {
          const message = error instanceof Error ? error.message : String(error)
          process.stderr.write(`[fork-transcript] persist failed: ${message}\n`)
          return null
        })
    }
  }
}
