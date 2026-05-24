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
import { loadChannelConfig } from '../channels/config.js'
import { channelInterjectionQueue } from '../channels/feishu/interjection-queue.js'
import { buildWorkerActivityForwarder } from '../channels/feishu/worker-activity-stream.js'
import { createUserMessage } from '../messages.js'
import { buildPromptForRole } from '../prompt.js'
import { query } from '../query.js'
import { getCurrentSessionContext, runWithSessionContext } from '../session-context.js'
import { getDaemonLocalRuntime, getRuntime } from '../state.js'
import type { CanUseToolFn, Tool } from '../tool.js'
import { forkInvocationContext } from './invocation-context.js'
import { stallTrace } from '../stall-trace.js'
import type { ChainState } from '../signal-bus/chain-state.js'
import type {
  Message,
  UsageStats,
  UserContentBlock,
} from '../types.js'
import type { Role } from './types.js'
import { deriveCanUseTool } from './role-tool-gate.js'
import { getForkTranscriptPath, persistForkTranscript } from './fork-transcript.js'

export type DispatchedAgentParams = {
  /** Caller-authored task brief. This is the dispatched agent's first user message. */
  dispatchPrompt: string
  /** Optional inline content blocks (image / pdf, already base64-encoded by
   *  the caller) appended after the prompt text in the same user message.
   *  Use prepareDispatchAttachments() to build these from paths so the
   *  worker sees attachments natively instead of re-Reading bytes. */
  dispatchAttachmentBlocks?: UserContentBlock[]
  role: Role
  tools: Tool[]
  config: LightClawConfig
  currentRoleOverride?: Role
  canonicalUser?: string
  chainState?: ChainState
  canUseToolOverride?: CanUseToolFn
  queryImpl?: typeof query
  // Optional cap on tool-use turns for this dispatch. Memory extraction passes a
  // small explicit value (intentional short task); subagent invocations leave
  // it undefined so query() falls back to config.turns.main / no cap.
  maxTurns?: number
  label: string
  signal?: AbortSignal
  mode?: 'sync' | 'bg'
  /** Optional incremental transcript persistence. When set, runDispatchedAgent
   *  pre-writes the initial dispatch messages through it and forwards it to
   *  query() so each completed tool round-trip is flushed as it lands.
   *  Background fires use it to keep a crashed long fire's partial transcript
   *  on disk instead of losing the whole fire. */
  persistMessages?: (messages: Message[]) => Promise<void> | void
  /** Optional transcript resync, paired with `persistMessages`. query() calls
   *  it after a mid-fire compaction rewrites the message prefix, then resumes
   *  incremental persistence from the compacted baseline. */
  rewriteMessages?: (messages: Message[]) => Promise<void> | void
}

export type DispatchedAgentResult = {
  finalText: string
  stopReason: string | null
  usage: UsageStats
  messages: Message[]
  forkTranscriptPath: string | null
  forkTranscriptPersisted: Promise<string | null>
}

export function buildDispatchedInitialMessages(
  dispatchPrompt: string,
  attachmentBlocks?: UserContentBlock[],
) {
  if (attachmentBlocks && attachmentBlocks.length > 0) {
    return [
      createUserMessage([
        { type: 'text' as const, text: dispatchPrompt },
        ...attachmentBlocks,
      ]),
    ]
  }
  return [createUserMessage(dispatchPrompt)]
}

export async function runDispatchedAgent(
  params: DispatchedAgentParams,
): Promise<DispatchedAgentResult> {
  const currentCtx = getCurrentSessionContext()
  const messages = [
    ...buildDispatchedInitialMessages(
      params.dispatchPrompt,
      params.dispatchAttachmentBlocks,
    ),
  ]
  const systemPrompt = await buildPromptForRole(params.role, {
    tools: params.tools,
    config: params.config,
    cwd: currentCtx?.cwd,
    sessionId: currentCtx?.sessionId,
    environmentRoot: getRuntime().workspaceRoot,
    scratchRoot: getRuntime().scratchRoot,
  })
  const canUseTool = params.canUseToolOverride ?? deriveCanUseTool(params.role)
  const forkId = randomUUID().slice(0, 8)
  const forkTranscriptPath = currentCtx
    ? getForkTranscriptPath({
        sessionsDir: currentCtx.sessionsDir,
        parentSessionId: currentCtx.sessionId,
        roleAgentType: params.role.agentType,
        forkId,
      })
    : null

  // Worker chain sessionId = the last node in this worker's chain path.
  // Scheduler routes bg-dispatch results spawned by this worker back to
  // that sessionId in the interjection queue; drain at every tool boundary
  // so receipt happens at the same cadence as user-driven interjections.
  const chainSessionId = params.chainState?.path.at(-1)?.sessionId
  // Read-only Feishu observability stream: forward each worker assistant
  // turn to the chat that initiated the chain. Returns undefined when the
  // config flag is off, the chain root sessionId is not a Feishu session,
  // or when there's no Feishu sender registered (terminal-only sessions).
  // loadChannelConfig() is called once per worker construction (not per
  // turn), which is acceptable given dispatch frequency.
  //
  // bg dispatch is fire-and-forget by design: caller already moved on, and
  // streaming intermediate turns back to the originating chat re-couples
  // the bg task to user attention (especially bad for scheduled fires at
  // unattended hours). bg results come back via the wake / interjection
  // path on completion; intermediate visibility belongs to blocking
  // dispatch only.
  const activityForwarder = params.chainState && params.mode !== 'bg'
    ? buildWorkerActivityForwarder({
        chainState: params.chainState,
        enabled: loadChannelConfig().feishu.streamWorkerActivity,
      })
    : undefined
  const run = () => (params.queryImpl ?? query)({
    role: params.role,
    invocation: forkInvocationContext({
      systemPrompt,
      canUseTool,
      cacheBreakpointMessageIndex: 0,
      signal: params.signal,
      subagentLabel: params.label,
      currentRoleOverride: params.currentRoleOverride,
      chainState: params.chainState,
      ...(chainSessionId
        ? { interjectionDrain: () => channelInterjectionQueue.drain(chainSessionId) }
        : {}),
      ...(activityForwarder ? { onAssistantTurn: activityForwarder } : {}),
      ...(params.persistMessages ? { persistMessages: params.persistMessages } : {}),
      ...(params.rewriteMessages ? { rewriteMessages: params.rewriteMessages } : {}),
    }),
    messages,
    tools: params.tools,
    config: params.config,
    maxTurns: params.maxTurns,
  })
  // Dispatches always start fresh. The marker is kept at zero so fork
  // transcript parsing stays backward-compatible with older files.
  const forkContextEndIndex = 0
  let messagesToPersist: Message[] = messages
  let persistTask: Promise<string | null> | null = null
  // Worker ALS sessionId comes from the chain path's last node so per-
  // sessionId state (api-logger dir, todos persist, session-memory, hooks)
  // splits cleanly from main. The parent fork-transcript path above keeps
  // using currentCtx.sessionId since that captures "which main session
  // spawned this fork" on disk. chainState rides on the SessionContext so
  // role-aware publishers (todo-write → progress) can resolve the chain
  // path and chain-root sessionId without re-reading invocation state.
  const childCtx = currentCtx
    ? {
        ...currentCtx,
        currentRole: params.role,
        sessionId: chainSessionId ?? currentCtx.sessionId,
        chainState: params.chainState,
        discoveredTools: new Map(),
        turnCounter: 0,
        // Framework-internal roles (memoryExtractor / memoryCurator) work
        // purely on daemon-side data — the memory tree and session
        // transcripts. Pin them to a host-direct runtime so their
        // environment-domain tools (Glob / Grep / Read) are not blinded by
        // whatever sandbox runtime the triggering turn happened to hold; a
        // Docker / Rlaunch sandbox mounts the user workspace, not those dirs.
        ...(params.role.kind === 'internal'
          ? { runtime: getDaemonLocalRuntime() }
          : {}),
      }
    : null
  // Incremental transcript persistence: hand the caller the initial dispatch
  // messages so a crash-time partial transcript starts coherently from the
  // dispatch prompt; query() then flushes each completed tool round-trip
  // through the same callback. Best-effort — a persist failure must not
  // abort the dispatch.
  if (params.persistMessages) {
    try {
      await params.persistMessages(messages)
    } catch (error) {
      process.stderr.write(
        `[dispatched-agent] initial persistMessages failed: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      )
    }
  }
  const dispatchedSid = chainSessionId ?? currentCtx?.sessionId
  stallTrace('dispatched-agent-enter', { sid: dispatchedSid, role: params.role.agentType, mode: params.mode })
  try {
    const t0 = Date.now()
    const result = childCtx
      ? await runWithSessionContext(childCtx, run)
      : await run()
    stallTrace('dispatched-agent-query-returned', { sid: dispatchedSid, role: params.role.agentType, ms: Date.now() - t0, stop: result.stopReason })
    messagesToPersist = result.messages
    if (forkTranscriptPath) {
      persistTask = persistForkTranscript(
        forkTranscriptPath,
        messagesToPersist,
        forkContextEndIndex,
      )
        .then(() => {
          return forkTranscriptPath
        })
        .catch(error => {
          const message = error instanceof Error ? error.message : String(error)
          process.stderr.write(`[fork-transcript] persist failed: ${message}\n`)
          return null
        })
    }

    stallTrace('dispatched-agent-exit', { sid: dispatchedSid, role: params.role.agentType, outcome: 'success' })
    return {
      finalText: result.assistantText,
      stopReason: result.stopReason,
      usage: result.usage,
      messages: result.messages,
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
