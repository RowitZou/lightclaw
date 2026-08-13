import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import type { Readable } from 'node:stream'

import { clampPermissionMode, type PermissionApprover, type PermissionMode, type PermissionRule } from './permission/types.js'
import type { Runtime } from './runtime/index.js'
import type { PermissionDenialDetail } from './background-task/types.js'
import type { TodoItem, UsageStats } from './types.js'
import type { ChannelKey } from './channel-types.js'
import type { Role } from './agents/types.js'
import type { ChainState } from './signal-bus/chain-state.js'

export type ChannelFileSendInput = {
  name: string
  sizeBytes: number
  read: () => Promise<Buffer>
  createReadStream?: () => Promise<Readable>
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
  /** Resolved per-user config snapshot for this session (PR4). Produced by
   *  `resolveUserConfig(<canonicalUser>, getConfig())` at session creation, so
   *  model-selection reads (`getSessionConfig()`) see the user's merged
   *  defaultModel / lang while global infra stays on `getConfig()`. Optional so
   *  the placeholder ctx (`createEmptySessionContext`) and fallback callers can
   *  omit it; `getSessionConfig()` falls back to `getConfig()` when absent. */
  config?: import('./config.js').LightClawConfig
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
  /** Per-turn guard for inline skill composition. Reset at each model turn. */
  inlineComposeThisTurn?: number
  /** Skill names written by skillConsolidator in this session. SkillEdit uses
   *  this to distinguish extract-new from compose-existing journal entries. */
  skillCompositionCreatedSkills?: Set<string>
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
  /** Platform messageId of the inbound that opened this main turn (Feishu
   *  message_id). Set on channel main turns only; absent for dispatched
   *  workers / background fires / synthetic turns. `TaskCreate` stamps it onto
   *  the recall-root index so a later recall of that opener message can find
   *  the root TaskRun(s) it started and surface a withdrawal signal to main. */
  openerMessageId?: string
  /** Transient per-handling flag: set when this turn-sequence took a
   *  user-facing disposition on a TaskRun via TaskUpdate — deliver (a root
   *  closed / a run delivered), accept of a standing fire, or a
   *  requester-hold parking a goal root. The channel runner reads it to route
   *  a synthetic-wake FINAL block to chat — an outcome the user should see
   *  even while OTHER roots stay open (the wake's own root may not be
   *  terminal). Naturally per-handling: a fresh SessionContext is created per
   *  inbound, so it starts unset. Best-effort. */
  concludedRootThisTurn?: boolean
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
  config?: import('./config.js').LightClawConfig
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
  openerMessageId?: string
}): SessionContext {
  return {
    sessionId: input.sessionId ?? randomUUID(),
    channel: input.channel,
    cwd: input.cwd,
    model: input.model,
    config: input.config,
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
    inlineComposeThisTurn: 0,
    skillCompositionCreatedSkills: new Set(),
    runtime: input.runtime,
    isBackgroundTask: input.isBackgroundTask,
    onPermissionDenial: input.onPermissionDenial,
    currentTaskRunId: input.currentTaskRunId,
    openerMessageId: input.openerMessageId,
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
    inlineComposeThisTurn: 0,
    skillCompositionCreatedSkills: new Set(),
    runtime: undefined,
    ...input,
  }
}
