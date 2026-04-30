import { randomUUID } from 'node:crypto'

import type { PermissionMode, PermissionRule } from './permission/types.js'
import { ImageReadinessTracker } from './runtime/image-readiness.js'
import { RuntimePool } from './runtime/pool.js'
import type { Runtime } from './runtime/index.js'
import type { TodoItem, UsageStats } from './types.js'

type SessionState = {
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
  sessionRules: PermissionRule[]
  fileRules: PermissionRule[]
  activeSkillAllowedTools?: string[]
  abortController: AbortController
  backgroundTasks: Set<Promise<unknown>>
  runtime?: Runtime
}

let state: SessionState | null = null
let runtimePool: RuntimePool | null = null
let imageReadiness: ImageReadinessTracker | null = null
// Session-memory write throttle counters. Module-level rather than per-state
// because they reset on every initializeState (a new session starts with
// zero accumulated work). They drive the SessionMemory double-threshold:
// SM is rewritten only when both token AND tool_call counters cross.
let sessionMemoryTokensSinceUpdate = 0
let sessionMemoryToolCallsSinceUpdate = 0
let sessionMemoryUpdateCount = 0
// Phase 14 micro-compact counters. Module-level for the same reason as the
// SessionMemory throttles above — they reset on every initializeState (a
// fresh session starts with zero MC actions).
let perToolSummaryCount = 0
let idleMicroCompactCount = 0
// Session permission rules persist per canonical user across channel
// resetSessionContext / initializeState calls — without this, the Feishu
// "批准所有" button (and terminal `[a]`) would silently degrade to
// "allow once" because writeSessionState reseeds state.sessionRules to []
// on every inbound channel message. Module-level map (process lifetime,
// LightClaw harness restart wipes it; same expiry as before, just no
// longer wiped per message turn).
const sessionRulesByUser = new Map<string, PermissionRule[]>()

function userKeyForRules(currentUserId: string | undefined): string {
  return currentUserId ?? '__terminal__'
}

export function initializeState(input: {
  cwd: string
  model: string
  sessionsDir: string
  memoryDir: string
  currentUserId?: string
  sessionId?: string
  resumedFrom?: string | null
  compactionCount?: number
  lastExtractedAt?: number
  todos?: TodoItem[]
  permissionMode?: PermissionMode
  cliArgRules?: PermissionRule[]
  fileRules?: PermissionRule[]
  runtime?: Runtime
}): void {
  state = {
    sessionId: input.sessionId ?? randomUUID(),
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
    sessionRules: sessionRulesByUser.get(userKeyForRules(input.currentUserId)) ?? [],
    fileRules: input.fileRules ?? [],
    activeSkillAllowedTools: undefined,
    abortController: new AbortController(),
    backgroundTasks: new Set(),
    runtime: input.runtime,
  }

  sessionMemoryTokensSinceUpdate = 0
  sessionMemoryToolCallsSinceUpdate = 0
  sessionMemoryUpdateCount = 0
  perToolSummaryCount = 0
  idleMicroCompactCount = 0
}

function requireState(): SessionState {
  if (!state) {
    throw new Error('State has not been initialized.')
  }

  return state
}

export function getSessionId(): string {
  return requireState().sessionId
}

export function getCwd(): string {
  return requireState().cwd
}

export function setCwd(cwd: string): void {
  requireState().cwd = cwd
}

export function getModel(): string {
  return requireState().model
}

export function setModel(model: string): void {
  requireState().model = model
}

export function getSessionsDir(): string {
  return requireState().sessionsDir
}

export function getMemoryDir(): string {
  return requireState().memoryDir
}

export function getCurrentUserId(): string | undefined {
  return requireState().currentUserId
}

export function requireCurrentUserId(): string {
  const userId = requireState().currentUserId
  if (!userId) {
    throw new Error('No LightClaw identity is active for this session.')
  }
  return userId
}

export function setCurrentUserId(userId: string | undefined): void {
  requireState().currentUserId = userId
}

export function getResumedFrom(): string | null {
  return requireState().resumedFrom
}

export function incrementCompactionCount(): number {
  const current = requireState()
  current.compactionCount += 1
  return current.compactionCount
}

export function getCompactionCount(): number {
  return requireState().compactionCount
}

export function getLastExtractedAt(): number {
  return requireState().lastExtractedAt
}

export function setLastExtractedAt(timestamp: number): void {
  requireState().lastExtractedAt = timestamp
}

export function getTodos(): TodoItem[] {
  return [...requireState().todos]
}

export function setTodos(todos: TodoItem[]): void {
  requireState().todos = [...todos]
}

export function getPermissionMode(): PermissionMode {
  return requireState().permissionMode
}

export function setPermissionMode(mode: PermissionMode): void {
  requireState().permissionMode = mode
}

export function getSessionRules(): PermissionRule[] {
  return [...requireState().sessionRules]
}

export function addSessionRule(rule: PermissionRule): void {
  // Mutate in place so the array shared with sessionRulesByUser stays in sync.
  // (state.sessionRules and the map value point at the same Array.)
  const current = requireState()
  current.sessionRules.push(rule)
  sessionRulesByUser.set(userKeyForRules(current.currentUserId), current.sessionRules)
}

export function clearSessionRules(): void {
  const current = requireState()
  // Clear in place to keep the map's reference aligned with state.sessionRules,
  // then drop the map entry so a fresh `initializeState` for this user starts
  // empty rather than reusing a now-stale array.
  current.sessionRules.length = 0
  sessionRulesByUser.delete(userKeyForRules(current.currentUserId))
}

export function getCliArgRules(): PermissionRule[] {
  return [...requireState().cliArgRules]
}

export function setCliArgRules(rules: PermissionRule[]): void {
  requireState().cliArgRules = [...rules]
}

export function getFileRules(): PermissionRule[] {
  return [...requireState().fileRules]
}

export function setFileRules(rules: PermissionRule[]): void {
  requireState().fileRules = [...rules]
}

export function getRuntime(): Runtime {
  const runtime = requireState().runtime
  if (!runtime) {
    throw new Error('Runtime has not been initialized. Did initializeApp() complete?')
  }

  return runtime
}

export function getRuntimeIfInitialized(): Runtime | undefined {
  return state?.runtime
}

export function setRuntime(runtime: Runtime): void {
  requireState().runtime = runtime
}

export function getRuntimePool(): RuntimePool {
  runtimePool ??= new RuntimePool()
  return runtimePool
}

export function getImageReadiness(): ImageReadinessTracker {
  imageReadiness ??= new ImageReadinessTracker()
  return imageReadiness
}

export function getAllPermissionRules(): PermissionRule[] {
  const current = requireState()
  return [
    ...current.cliArgRules,
    ...current.sessionRules,
    ...current.fileRules,
  ]
}

export function getActiveSkillAllowedTools(): string[] | undefined {
  const allowedTools = requireState().activeSkillAllowedTools
  return allowedTools ? [...allowedTools] : undefined
}

export function setActiveSkillAllowedTools(allowedTools: string[] | undefined): void {
  requireState().activeSkillAllowedTools = allowedTools ? [...allowedTools] : undefined
}

export function clearActiveSkillAllowedTools(): void {
  requireState().activeSkillAllowedTools = undefined
}

export function getAbortController(): AbortController {
  return requireState().abortController
}

export function resetAbortController(): AbortController {
  const current = requireState()
  current.abortController = new AbortController()
  return current.abortController
}

export function addUsage(usage: UsageStats): void {
  const current = requireState()
  current.totalInputTokens += usage.input_tokens ?? 0
  current.totalOutputTokens += usage.output_tokens ?? 0
}

export function getUsageTotals(): {
  inputTokens: number
  outputTokens: number
} {
  const current = requireState()
  return {
    inputTokens: current.totalInputTokens,
    outputTokens: current.totalOutputTokens,
  }
}

export function registerBackgroundTask(task: Promise<unknown>): void {
  const current = requireState()
  current.backgroundTasks.add(task)
  void task.finally(() => {
    current.backgroundTasks.delete(task)
  })
}

export async function awaitBackgroundTasks(): Promise<void> {
  const current = requireState()
  if (current.backgroundTasks.size === 0) {
    return
  }

  await Promise.allSettled([...current.backgroundTasks])
}

export function getSessionMemoryTokensSinceUpdate(): number {
  return sessionMemoryTokensSinceUpdate
}

export function addSessionMemoryTokens(tokens: number): void {
  if (tokens > 0) {
    sessionMemoryTokensSinceUpdate += tokens
  }
}

export function getSessionMemoryToolCallsSinceUpdate(): number {
  return sessionMemoryToolCallsSinceUpdate
}

export function addSessionMemoryToolCall(): void {
  sessionMemoryToolCallsSinceUpdate += 1
}

export function resetSessionMemoryCounters(): void {
  sessionMemoryTokensSinceUpdate = 0
  sessionMemoryToolCallsSinceUpdate = 0
}

export function getSessionMemoryUpdateCount(): number {
  return sessionMemoryUpdateCount
}

export function incrementSessionMemoryUpdateCount(): number {
  sessionMemoryUpdateCount += 1
  return sessionMemoryUpdateCount
}

export function getPerToolSummaryCount(): number {
  return perToolSummaryCount
}

export function incrementPerToolSummaryCount(): number {
  perToolSummaryCount += 1
  return perToolSummaryCount
}

export function getIdleMicroCompactCount(): number {
  return idleMicroCompactCount
}

export function incrementIdleMicroCompactCount(): number {
  idleMicroCompactCount += 1
  return idleMicroCompactCount
}
