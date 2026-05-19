/**
 * Dispatched-agent runner: a background or user-visible agent that starts
 * from an explicit task brief and accumulates its own transcript.
 *
 * Dispatch is intentionally not fork: the runner does not inherit the parent
 * transcript. Any context the worker should see must be included by the caller
 * in `dispatchPrompt`.
 */

import { randomUUID } from 'node:crypto'
import path from 'node:path'

import type { LightClawConfig } from '../config.js'
import { SESSION_MEMORY_FILENAME } from '../memory/session-memory.js'
import { loadChannelConfig } from '../channels/config.js'
import { channelInterjectionQueue } from '../channels/feishu/interjection-queue.js'
import { buildWorkerActivityForwarder } from '../channels/feishu/worker-activity-stream.js'
import { createUserMessage } from '../messages.js'
import { buildPromptForRole } from '../prompt.js'
import { query } from '../query.js'
import { getCurrentSessionContext, runWithSessionContext, type SessionContext } from '../session-context.js'
import { getRuntime } from '../state.js'
import type { CanUseToolFn, Tool } from '../tool.js'
import { forkInvocationContext } from './invocation-context.js'
import type { ChainState } from '../signal-bus/chain-state.js'
import type {
  Message,
  UsageStats,
  UserContentBlock,
} from '../types.js'
import type { AgentType, Role } from './types.js'
import { deriveCanUseTool } from './role-tool-gate.js'
import { getForkTranscriptPath, parseForkTranscriptFile, persistForkTranscript } from './fork-transcript.js'
import {
  loadDispatchSnapshot,
  loadLatestDispatchSnapshot,
  persistDispatchSnapshot,
  type ResumableSessionSnapshot,
} from './resumable-snapshot.js'

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
  callerAgentType?: AgentType
  canonicalUser?: string
  resumeFrom?: string
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
}

export type DispatchedAgentResult = {
  finalText: string
  stopReason: string | null
  usage: UsageStats
  messages: Message[]
  forkTranscriptPath: string | null
  forkTranscriptPersisted: Promise<string | null>
  resumedFromDispatchId?: string
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
  const principal = params.canonicalUser ?? currentCtx?.currentUserId
  const callerAgentType =
    params.callerAgentType
    ?? currentCtx?.currentRole?.agentType
    ?? params.currentRoleOverride?.agentType
    ?? 'main'
  const resume = await resolveResumeSnapshot({
    resumeFrom: params.resumeFrom,
    principal,
    callerAgentType,
    calleeAgentType: params.role.agentType,
  })
  const inheritedMessages = resume?.messages ?? []
  const messages = [
    ...inheritedMessages,
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
    }),
    messages,
    tools: params.tools,
    config: params.config,
    maxTurns: params.maxTurns,
  })
  // Fresh dispatch has no inherited prefix. Resumed dispatch prefixes the
  // previous worker transcript and marks the new prompt boundary so extraction
  // still analyzes only this fire's own work.
  const forkContextEndIndex = inheritedMessages.length
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
        ...(resume?.snapshot.todos ? { todos: [...resume.snapshot.todos] } : {}),
        ...(resume?.snapshot.compactionCount !== undefined
          ? { compactionCount: resume.snapshot.compactionCount }
          : {}),
        discoveredTools: new Map(resume?.snapshot.discoveredTools ?? []),
        turnCounter: 0,
      }
    : null
  try {
    const result = childCtx
      ? await runWithSessionContext(childCtx, run)
      : await run()
    messagesToPersist = result.messages
    if (forkTranscriptPath) {
      persistTask = persistForkTranscript(
        forkTranscriptPath,
        messagesToPersist,
        forkContextEndIndex,
      )
        .then(async () => {
          await maybePersistDispatchSnapshot({
            params,
            principal,
            callerAgentType,
            forkTranscriptPath,
            forkContextEndIndex,
            childCtx,
          })
          return forkTranscriptPath
        })
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
      messages: result.messages,
      forkTranscriptPath,
      forkTranscriptPersisted: persistTask ?? Promise.resolve(null),
      ...(resume ? { resumedFromDispatchId: resume.snapshot.dispatchId } : {}),
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

type ResolvedResumeSnapshot = {
  snapshot: ResumableSessionSnapshot
  messages: Message[]
}

export class ResumeSnapshotNotFoundError extends Error {
  constructor(
    public readonly callerAgentType: AgentType,
    public readonly calleeAgentType: AgentType,
    public readonly resumeFrom: string,
  ) {
    super(formatResumeSnapshotNotFound(callerAgentType, calleeAgentType, resumeFrom))
    this.name = 'ResumeSnapshotNotFoundError'
  }
}

async function resolveResumeSnapshot(input: {
  resumeFrom?: string
  principal?: string
  callerAgentType: AgentType
  calleeAgentType: AgentType
}): Promise<ResolvedResumeSnapshot | null> {
  if (!input.resumeFrom) return null
  if (!input.principal) {
    throw new ResumeSnapshotNotFoundError(
      input.callerAgentType,
      input.calleeAgentType,
      input.resumeFrom,
    )
  }

  const snapshot = input.resumeFrom === 'last'
    ? await loadLatestDispatchSnapshot({
        principal: input.principal,
        callerAgentType: input.callerAgentType,
        calleeAgentType: input.calleeAgentType,
      })
    : await loadDispatchSnapshot({
        principal: input.principal,
        callerAgentType: input.callerAgentType,
        calleeAgentType: input.calleeAgentType,
        dispatchId: input.resumeFrom,
      })
  if (!snapshot) {
    // 'last' is best-effort: when no prior snapshot exists for this (caller,
    // callee) pair, start fresh instead of throwing. This is critical for bg
    // recurring tasks created with resumeFrom='last' — the first fire has
    // nothing to resume from but should still run; subsequent fires pick up
    // the prior fire's snapshot. Blocking callers benefit too: the model
    // gets a clean fresh run instead of a self-correction round-trip.
    //
    // Explicit dispatchId stays strict: the caller named a specific id, so
    // not finding it is an error worth surfacing.
    if (input.resumeFrom === 'last') {
      return null
    }
    throw new ResumeSnapshotNotFoundError(
      input.callerAgentType,
      input.calleeAgentType,
      input.resumeFrom,
    )
  }

  const parsed = await parseForkTranscriptFile(snapshot.transcriptPath)
  return { snapshot, messages: parsed.messages }
}

function formatResumeSnapshotNotFound(
  callerAgentType: AgentType,
  calleeAgentType: AgentType,
  resumeFrom: string,
): string {
  const suffix = resumeFrom === 'last' ? '' : `/${resumeFrom}`
  return `No dispatch-history entry for ${callerAgentType}-${calleeAgentType}${suffix}. Snapshot may have expired (24h TTL) or never persisted. Retry without resumeFrom for a fresh dispatch.`
}

async function maybePersistDispatchSnapshot(input: {
  params: DispatchedAgentParams
  principal?: string
  callerAgentType: AgentType
  forkTranscriptPath: string
  forkContextEndIndex: number
  childCtx: SessionContext | null
}): Promise<void> {
  if (!input.principal || input.params.role.kind !== 'worker') return
  const dispatchId = input.params.chainState?.path.at(-1)?.dispatchId ?? randomUUID().slice(0, 8)
  const childCtx = input.childCtx
  const snapshot: ResumableSessionSnapshot = {
    schemaVersion: 1,
    chainId: input.params.chainState?.chainId ?? dispatchId,
    dispatchId,
    callerSessionId: childCtx?.sessionId ?? '',
    callerAgentType: input.callerAgentType,
    calleeAgentType: input.params.role.agentType,
    transcriptPath: input.forkTranscriptPath,
    forkContextEndIndex: input.forkContextEndIndex,
    ...(childCtx ? { todos: [...childCtx.todos] } : {}),
    ...(childCtx ? { discoveredTools: [...childCtx.discoveredTools.entries()] } : {}),
    ...(childCtx
      ? { sessionMemoryPath: path.join(childCtx.sessionsDir, childCtx.sessionId, SESSION_MEMORY_FILENAME) }
      : {}),
    ...(childCtx ? { compactionCount: childCtx.compactionCount } : {}),
    snapshotAt: new Date().toISOString(),
  }

  await persistDispatchSnapshot(snapshot, input.principal)
    .catch(error => {
      const message = error instanceof Error ? error.message : String(error)
      process.stderr.write(`[dispatch-history] snapshot persist failed: ${message}\n`)
    })
}
