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
import { channelInterjectionQueue } from '../channels/feishu/interjection-queue.js'
import { buildWorkerProgressForwarder } from '../taskrun/worker-progress.js'
import { createUserMessage } from '../messages.js'
import { buildPromptForRole } from '../prompt.js'
import { query } from '../query.js'
import { getCurrentSessionContext, runWithSessionContext } from '../session-context.js'
import { getDaemonLocalRuntime, getRuntime } from '../state.js'
import { resolveDispatchedFireSecrets } from './dispatch-secrets.js'
import type { CanUseToolFn, Tool } from '../tool.js'
import { forkInvocationContext } from './invocation-context.js'
import type { ChainState } from '../signal-bus/chain-state.js'
import {
  appendMessages,
  rewriteTranscript,
  touchMeta,
} from '../session/storage.js'
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
  currentTaskRunId?: string
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
  // Top-level secrets (Phase 18 follow-up, 2026-06-14): a background/scheduled
  // fire dispatched DIRECTLY by main carries the owner's enabled secrets so
  // owner-authorized actions (authenticated git push/clone, etc.) can run
  // unattended. The gate lives in resolveDispatchedFireSecrets so the resume
  // path can apply the identical predicate from the same chainState. The
  // returned map feeds both the prompt's `## Available Secrets` section below
  // and the childCtx env injection, so the two can never drift.
  const inheritedSecrets = resolveDispatchedFireSecrets(
    params.chainState,
    params.role,
    params.canonicalUser,
  )
  const systemPrompt = await buildPromptForRole(params.role, {
    tools: params.tools,
    config: params.config,
    cwd: currentCtx?.cwd,
    sessionId: currentCtx?.sessionId,
    environmentRoot: getRuntime().workspaceRoot,
    scratchRoot: getRuntime().scratchRoot,
    currentTaskRunId: params.currentTaskRunId,
    enabledSecrets: inheritedSecrets,
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
  // Worker observability (PR22): each assistant block lands as a throttled
  // progress event on the worker's own TaskRun, rendered under that child's
  // timeline on the task card. This replaced the per-block chat forwarder
  // (worker-activity-stream), which had been dead since blocking dispatch
  // retired and was disabled in topic groups anyway.
  const activityForwarder = params.currentTaskRunId
    ? buildWorkerProgressForwarder({
        taskRunId: params.currentTaskRunId,
        ...(params.canonicalUser ? { ownerCanonicalUser: params.canonicalUser } : {}),
      })
    : undefined
  // Default transcript persistence for dispatched workers. Callers that need a
  // bespoke write path (bg-fire truncates on retry; channel runner hooks into
  // its own rewrite cycle) keep passing persistMessages explicitly and win.
  // Otherwise — sync Dispatch from runSubagent, or any future caller that
  // forwards a chain — we write each completed tool round-trip to the chain
  // leaf's transcript so a crash mid-dispatch leaves a coherent partial on
  // disk and meta.messageCount stays honest for GC / audit. Gated on a chain
  // sessionId that's distinct from the parent: internal roles (extract /
  // curator) don't carry chainState, so they fall through unchanged and
  // remain fork-transcript-only.
  const shouldDefaultPersist =
    !params.persistMessages
    && chainSessionId !== undefined
    && chainSessionId !== currentCtx?.sessionId
  const persistTargetSessionId = chainSessionId
  let defaultPersistCount = 0
  const effectivePersist = params.persistMessages
    ?? (shouldDefaultPersist && persistTargetSessionId
      ? async (batch: Message[]) => {
          await appendMessages(persistTargetSessionId, batch)
          defaultPersistCount += batch.length
          await touchMeta(persistTargetSessionId, defaultPersistCount)
        }
      : undefined)
  const effectiveRewrite = params.rewriteMessages
    ?? (shouldDefaultPersist && persistTargetSessionId
      ? async (msgs: Message[]) => {
          await rewriteTranscript(persistTargetSessionId, msgs)
          defaultPersistCount = msgs.length
          await touchMeta(persistTargetSessionId, defaultPersistCount)
        }
      : undefined)
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
      ...(effectivePersist ? { persistMessages: effectivePersist } : {}),
      ...(effectiveRewrite ? { rewriteMessages: effectiveRewrite } : {}),
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
        currentTaskRunId: params.currentTaskRunId,
        discoveredTools: new Map(),
        turnCounter: 0,
        // Per-user runtime secrets (Phase 18). The childCtx is the single
        // chokepoint that decides whether a dispatched stack sees secrets in
        // `bash.ts`'s `getCurrentEnabledSecrets()`. The default is strip
        // (`undefined`): a grandchild dispatched by a sub-worker, and every
        // internal maintenance role, run with no secrets. The one exception is
        // a top-level fire dispatched directly by main (`isTopLevelMainFire`
        // above) — it carries the owner's enabled secrets, the same map the
        // worker's `## Available Secrets` prompt section was rendered from, so
        // the env injection and the prompt language are always consistent.
        // This line ALWAYS sets the field explicitly (to the top-level grant or
        // `undefined`), overriding whatever `...currentCtx` spread in — so an
        // ineligible stack can never inherit a parent's secrets even when the
        // parent ctx happens to carry them (e.g. an internal role dispatched
        // from main's own session via run-subagent).
        enabledSecrets: inheritedSecrets,
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
  if (effectivePersist) {
    try {
      await effectivePersist(messages)
    } catch (error) {
      process.stderr.write(
        `[dispatched-agent] initial persistMessages failed: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      )
    }
  }
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
        .then(() => {
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
