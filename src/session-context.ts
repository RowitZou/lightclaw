import { AsyncLocalStorage } from 'node:async_hooks'

import type { PermissionApprover, PermissionMode, PermissionRule } from './permission/types.js'
import type { Runtime } from './runtime/index.js'
import type { TodoItem, UsageStats } from './types.js'

/**
 * Per-query / per-REPL-loop session context. Every field that can differ
 * between concurrent users lives here. Process-wide services such as the
 * RuntimePool, image readiness tracker, and network bridge stay in state.ts.
 */
export type SessionContext = {
  sessionId: string
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
  abortController: AbortController
  backgroundTasks: Set<Promise<unknown>>
  runtime?: Runtime
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

/**
 * Channel runner / future REPL bootstrap helper. Returns a fully-typed but
 * empty SessionContext so callers can wrap the rest of the turn in
 * runWithSessionContext BEFORE resetSessionContext runs. Once inside the
 * scope, initializeState detects the active ctx and Object.assign's the
 * resolved fields onto it — never the module singleton — which is what
 * keeps two concurrent users' resets from clobbering each other.
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
    abortController: new AbortController(),
    backgroundTasks: new Set(),
    runtime: undefined,
    ...input,
  }
}
