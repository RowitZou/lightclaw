import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

import { clampPermissionMode, type PermissionApprover, type PermissionMode, type PermissionRule } from './permission/types.js'
import type { Runtime } from './runtime/index.js'
import type { PermissionDenialDetail } from './background-task/types.js'
import type { TodoItem, UsageStats } from './types.js'
import type { ChannelKey } from './channel-types.js'
import type { Role } from './agents/types.js'
import type { ChainState } from './signal-bus/chain-state.js'

export type ChannelFileSendInput = {
  content: Buffer
  name: string
  mimeType?: string
}

// SendFile delivery mode after the channel adapter resolves IM-vs-cloud
// fallback. `im-attachment` means the file was sent as a native IM file
// attachment (Feishu: ≤30 MB via `im.v1.files.create`). `cloud-link` means
// the file overflowed that ceiling, was uploaded to the user's drive uploads
// folder, and a share link was posted back to the chat — the LLM should
// surface the URL in its reply text so the user can click through.
export type ChannelFileSendOutput =
  | { kind: 'im-attachment' }
  | { kind: 'cloud-link'; url: string; sizeBytes: number }

export type ChannelFileSender = {
  channelId: string
  sendFile(file: ChannelFileSendInput): Promise<ChannelFileSendOutput>
}

export type ResourceGrantTarget = {
  chatId?: string
  senderOpenId?: string
}

/**
 * Per-query / per-REPL-loop session context. Every field that can differ
 * between concurrent users lives here. Process-wide services such as the
 * RuntimePool, image readiness tracker, and network bridge stay in state.ts.
 */
export type SessionContext = {
  sessionId: string
  channel?: ChannelKey
  cwd: string
  model: string
  sessionsDir: string
  memoryDir: string
  currentRole?: Role
  currentUserId?: string
  enabledSecrets?: ReadonlyMap<string, string>
  resumedFrom: string | null
  compactionCount: number
  lastExtractedAt: number
  totalInputTokens: number
  totalOutputTokens: number
  todos: TodoItem[]
  permissionMode: PermissionMode
  /** Hard cap on `permissionMode` for this session's user. `getPermissionMode`
   *  clamps the effective mode to this; `createSessionContext` also clamps the
   *  stored `permissionMode` at construction. */
  permissionCeiling: PermissionMode
  cliArgRules: PermissionRule[]
  identityRules: PermissionRule[]
  fileRules: PermissionRule[]
  permissionApprover: PermissionApprover | null
  channelFileSender: ChannelFileSender | null
  resourceGrantTarget?: ResourceGrantTarget
  abortController: AbortController
  backgroundTasks: Set<Promise<unknown>>
  /** name → turn index of last use (ToolSearch match OR actual tool_use).
   *  Map preserves insertion order for LRU cap; the value lets the per-turn
   *  catalog builder drop entries unused for `tools.discoveredToolsTtlTurns`
   *  turns. Session-scoped; daemon restart and dispatched-worker forks wipe it. */
  discoveredTools: Map<string, number>
  /** Monotone counter incremented at the start of each query-loop turn.
   *  Survives across multiple `query()` invocations within the same channel
   *  session (one user message = one query() = one or more turns; the
   *  channel runner shares the SessionContext, so the counter accumulates).
   *  Used by `markDiscovered` / `pruneStaleDiscoveredTools` for TTL eviction. */
  turnCounter: number
  /** `turnCounter` value at the last Memory Nudge injection. The next nudge
   *  is due once `turnCounter - lastMemoryNudgeTurn >= memoryNudge.everyTurns`.
   *  Session-scoped like `turnCounter`; survives across `query()` calls so a
   *  nudge missed on an `end_turn` boundary carries over. See
   *  `src/memory/nudge.ts`. */
  lastMemoryNudgeTurn: number
  runtime?: Runtime
  isBackgroundTask?: boolean
  onPermissionDenial?: (detail: PermissionDenialDetail) => void
  // Dispatch chain this session belongs to. main turn entries leave this
  // unset; dispatched workers (blocking + background) carry the chain so
  // role-aware signal publishers (progress, future events) can resolve
  // attribution and route through the chain root sessionId.
  chainState?: ChainState
  // Durable TaskRun currently executing in this session. A worker that dispatches
  // a child uses this id as the child's parentRunId; main turns leave it unset
  // until later phases introduce top-level goal task runs.
  currentTaskRunId?: string
}

export const sessionContextStorage = new AsyncLocalStorage<SessionContext>()

export function runWithSessionContext<T>(
  ctx: SessionContext,
  fn: () => Promise<T>,
): Promise<T> {
  return sessionContextStorage.run(ctx, fn)
}

export function getCurrentSessionContext(): SessionContext | undefined {
  return sessionContextStorage.getStore()
}

export function requireSessionContext(): SessionContext {
  const ctx = getCurrentSessionContext()
  if (!ctx) {
    throw new SessionContextNotInitializedError()
  }
  return ctx
}

export class SessionContextNotInitializedError extends Error {
  constructor() {
    super(
      'SessionContext has not been initialized. A state getter was called outside any runWithSessionContext scope.',
    )
    this.name = 'SessionContextNotInitializedError'
  }
}

export function usageFromContext(ctx: SessionContext): UsageStats {
  return {
    input_tokens: ctx.totalInputTokens,
    output_tokens: ctx.totalOutputTokens,
  }
}

export function createSessionContext(input: {
  cwd: string
  model: string
  sessionsDir: string
  memoryDir: string
  currentUserId?: string
  enabledSecrets?: ReadonlyMap<string, string>
  currentRole?: Role
  sessionId?: string
  channel?: ChannelKey
  resumedFrom?: string | null
  compactionCount?: number
  lastExtractedAt?: number
  todos?: TodoItem[]
  permissionMode?: PermissionMode
  permissionCeiling?: PermissionMode
  cliArgRules?: PermissionRule[]
  identityRules?: PermissionRule[]
  fileRules?: PermissionRule[]
  permissionApprover?: PermissionApprover | null
  channelFileSender?: ChannelFileSender | null
  resourceGrantTarget?: ResourceGrantTarget
  runtime?: Runtime
  isBackgroundTask?: boolean
  onPermissionDenial?: (detail: PermissionDenialDetail) => void
  currentTaskRunId?: string
}): SessionContext {
  return {
    sessionId: input.sessionId ?? randomUUID(),
    channel: input.channel,
    cwd: input.cwd,
    model: input.model,
    sessionsDir: input.sessionsDir,
    memoryDir: input.memoryDir,
    currentRole: input.currentRole,
    currentUserId: input.currentUserId,
    enabledSecrets: input.enabledSecrets,
    resumedFrom: input.resumedFrom ?? null,
    compactionCount: input.compactionCount ?? 0,
    lastExtractedAt: input.lastExtractedAt ?? 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    todos: input.todos ?? [],
    permissionMode: clampPermissionMode(
      input.permissionMode ?? 'default',
      input.permissionCeiling ?? 'bypassPermissions',
    ),
    permissionCeiling: input.permissionCeiling ?? 'bypassPermissions',
    cliArgRules: input.cliArgRules ?? [],
    identityRules: input.identityRules ?? [],
    fileRules: input.fileRules ?? [],
    permissionApprover: input.permissionApprover ?? null,
    channelFileSender: input.channelFileSender ?? null,
    resourceGrantTarget: input.resourceGrantTarget,
    abortController: new AbortController(),
    backgroundTasks: new Set(),
    discoveredTools: new Map(),
    turnCounter: 0,
    lastMemoryNudgeTurn: 0,
    runtime: input.runtime,
    isBackgroundTask: input.isBackgroundTask,
    onPermissionDenial: input.onPermissionDenial,
    currentTaskRunId: input.currentTaskRunId,
  }
}

/**
 * Channel runner / future REPL bootstrap helper. Returns a fully-typed but
 * empty SessionContext so callers can wrap the rest of the turn in
 * runWithSessionContext BEFORE resetSessionContext runs. Once inside the
 * scope, callers can Object.assign the resolved fields onto it — never a
 * module singleton — which is what keeps two concurrent users' resets from
 * clobbering each other.
 *
 * Pass the few fields known up-front (sessionId, currentUserId); the rest
 * are placeholders overwritten by reset.
 */
export function createEmptySessionContext(input?: Partial<SessionContext>): SessionContext {
  return {
    sessionId: '',
    cwd: '',
    model: '',
    sessionsDir: '',
    memoryDir: '',
    currentRole: undefined,
    resumedFrom: null,
    enabledSecrets: undefined,
    compactionCount: 0,
    lastExtractedAt: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    todos: [],
    permissionMode: 'default',
    permissionCeiling: 'bypassPermissions',
    cliArgRules: [],
    identityRules: [],
    fileRules: [],
    permissionApprover: null,
    channelFileSender: null,
    resourceGrantTarget: undefined,
    abortController: new AbortController(),
    backgroundTasks: new Set(),
    discoveredTools: new Map(),
    turnCounter: 0,
    lastMemoryNudgeTurn: 0,
    runtime: undefined,
    ...input,
  }
}
