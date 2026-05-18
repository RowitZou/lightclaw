/**
 * Dispatched-agent runner: a background or user-visible agent that starts
 * from an explicit task brief and accumulates its own transcript.
 *
 * Dispatch is intentionally not fork: the runner does not inherit the parent
 * transcript. Any context the worker should see must be included by the caller
 * in `dispatchPrompt`.
 */

import { randomUUID } from 'node:crypto'

import type { LightClawConfig } from '../config.js'
import { createUserMessage } from '../messages.js'
import { buildPromptForRole } from '../prompt.js'
import { query } from '../query.js'
import { getCurrentSessionContext, runWithSessionContext } from '../session-context.js'
import { getRuntime } from '../state.js'
import type { CanUseToolFn, Tool } from '../tool.js'
import { forkInvocationContext } from './invocation-context.js'
import type { ChainState } from '../signal-bus/chain-state.js'
import type {
  Message,
  UsageStats,
} from '../types.js'
import type { Role } from './types.js'
import { deriveCanUseTool } from './role-tool-gate.js'
import { getForkTranscriptPath, persistForkTranscript } from './fork-transcript.js'

export type DispatchedAgentParams = {
  /** Caller-authored task brief. This is the dispatched agent's first user message. */
  dispatchPrompt: string
  role: Role
  tools: Tool[]
  config: LightClawConfig
  currentRoleOverride?: Role
  chainState?: ChainState
  canUseToolOverride?: CanUseToolFn
  // Optional cap on tool-use turns for this dispatch. Memory extraction passes a
  // small explicit value (intentional short task); subagent invocations leave
  // it undefined so query() falls back to config.maxTurns / no cap.
  maxTurns?: number
  label: string
  signal?: AbortSignal
}

export type DispatchedAgentResult = {
  finalText: string
  stopReason: string | null
  usage: UsageStats
  forkTranscriptPath: string | null
  forkTranscriptPersisted: Promise<string | null>
}

export function buildDispatchedInitialMessages(dispatchPrompt: string) {
  return [createUserMessage(dispatchPrompt)]
}

export async function runDispatchedAgent(
  params: DispatchedAgentParams,
): Promise<DispatchedAgentResult> {
  const messages = buildDispatchedInitialMessages(params.dispatchPrompt)
  const systemPrompt = await buildPromptForRole(params.role, {
    tools: params.tools,
    config: params.config,
    cwd: getCurrentSessionContext()?.cwd,
    sessionId: getCurrentSessionContext()?.sessionId,
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
      cacheBreakpointMessageIndex: 0,
      signal: params.signal,
      subagentLabel: params.label,
      currentRoleOverride: params.currentRoleOverride,
      chainState: params.chainState,
    }),
    messages,
    tools: params.tools,
    config: params.config,
    maxTurns: params.maxTurns,
  })
  // There is no inherited parent prefix in dispatch semantics. A zero marker
  // means the whole transcript is the dispatched agent's own work.
  const forkContextEndIndex = 0
  let messagesToPersist: Message[] = messages
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
