import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

import type { PermissionApprover, PermissionMode, PermissionRule } from './permission/types.js'
import type { Runtime } from './runtime/index.js'
import type { PermissionDenialDetail } from './background-task/types.js'
import type { TodoItem, UsageStats } from './types.js'
import type { ChannelKey } from './channel-types.js'

export type ChannelFileSendInput = {
  content: Buffer
  name: string
  mimeType?: string
}

export type ChannelFileSender = {
  channelId: string
  sendFile(file: ChannelFileSendInput): Promise<void>
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
  currentUserId?: string
  resumedFrom: string | null
  compactionCount: number
  lastExtractedAt: number
  totalInputTokens: number
  totalOutputTokens: number
  todos: TodoItem[]
  permissionMode: PermissionMode
  cliArgRules: PermissionRule[]
  identityRules: PermissionRule[]
  fileRules: PermissionRule[]
  activeSkillAllowedTools?: string[]
  permissionApprover: PermissionApprover | null
  channelFileSender: ChannelFileSender | null
  abortController: AbortController
  backgroundTasks: Set<Promise<unknown>>
  /** name → turn index of last use (ToolSearch match OR actual tool_use).
   *  Map preserves insertion order for LRU cap; the value lets the per-turn
   *  catalog builder drop entries unused for `tools.discoveredToolsTtlTurns`
   *  turns. Session-scoped; daemon restart / `/fresh` / fork all wipe it. */
  discoveredTools: Map<string, number>
  /** Monotone counter incremented at the start of each query-loop turn.
   *  Survives across multiple `query()` invocations within the same channel
   *  session (one user message = one query() = one or more turns; the
   *  channel runner shares the SessionContext, so the counter accumulates).
   *  Used by `markDiscovered` / `pruneStaleDiscoveredTools` for TTL eviction. */
  turnCounter: number
  runtime?: Runtime
  isBackgroundTask?: boolean
  taskAllowedTools?: string[]
  onPermissionDenial?: (detail: PermissionDenialDetail) => void
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
  sessionId?: string
  channel?: ChannelKey
  resumedFrom?: string | null
  compactionCount?: number
  lastExtractedAt?: number
  todos?: TodoItem[]
  permissionMode?: PermissionMode
  cliArgRules?: PermissionRule[]
  identityRules?: PermissionRule[]
  fileRules?: PermissionRule[]
  activeSkillAllowedTools?: string[]
  permissionApprover?: PermissionApprover | null
  channelFileSender?: ChannelFileSender | null
  runtime?: Runtime
  isBackgroundTask?: boolean
  taskAllowedTools?: string[]
  onPermissionDenial?: (detail: PermissionDenialDetail) => void
}): SessionContext {
  return {
    sessionId: input.sessionId ?? randomUUID(),
    channel: input.channel,
    cwd: input.cwd,
    model: input.model,
    sessionsDir: input.sessionsDir,
    memoryDir: input.memoryDir,
    currentUserId: input.currentUserId,
    resumedFrom: input.resumedFrom ?? null,
    compactionCount: input.compactionCount ?? 0,
    lastExtractedAt: input.lastExtractedAt ?? 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    todos: input.todos ?? [],
    permissionMode: input.permissionMode ?? 'default',
    cliArgRules: input.cliArgRules ?? [],
    identityRules: input.identityRules ?? [],
    fileRules: input.fileRules ?? [],
    activeSkillAllowedTools: input.activeSkillAllowedTools,
    permissionApprover: input.permissionApprover ?? null,
    channelFileSender: input.channelFileSender ?? null,
    abortController: new AbortController(),
    backgroundTasks: new Set(),
    discoveredTools: new Map(),
    turnCounter: 0,
    runtime: input.runtime,
    isBackgroundTask: input.isBackgroundTask,
    taskAllowedTools: input.taskAllowedTools,
    onPermissionDenial: input.onPermissionDenial,
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
    resumedFrom: null,
    compactionCount: 0,
    lastExtractedAt: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    todos: [],
    permissionMode: 'default',
    cliArgRules: [],
    identityRules: [],
    fileRules: [],
    activeSkillAllowedTools: undefined,
    permissionApprover: null,
    channelFileSender: null,
    abortController: new AbortController(),
    backgroundTasks: new Set(),
    discoveredTools: new Map(),
    turnCounter: 0,
    runtime: undefined,
    ...input,
  }
}
