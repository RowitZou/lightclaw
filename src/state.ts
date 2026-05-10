import type {
  PermissionApprover,
  PermissionMode,
  PermissionRule,
} from './permission/types.js'
import { ImageReadinessTracker } from './runtime/image-readiness.js'
import type { NetworkBridge } from './runtime/network-bridge.js'
import { RuntimePool } from './runtime/pool.js'
import type { Runtime } from './runtime/index.js'
import {
  getCurrentSessionContext,
  requireSessionContext,
  type ChannelFileSender,
  type SessionContext,
} from './session-context.js'
import type { TodoItem, UsageStats } from './types.js'

type SessionState = SessionContext

let runtimePool: RuntimePool | null = null
let imageReadiness: ImageReadinessTracker | null = null
let networkBridge: NetworkBridge | null = null
const abortControllerByUser = new Map<string, AbortController>()
// Session-memory write throttle counters. Module-level rather than per-state
// because they reset on every resolved SessionContext (a new session starts with
// zero accumulated work). They drive the SessionMemory double-threshold:
// SM is rewritten only when both token AND tool_call counters cross.
let sessionMemoryTokensSinceUpdate = 0
let sessionMemoryToolCallsSinceUpdate = 0
let sessionMemoryUpdateCount = 0
// Phase 14 micro-compact counters. Module-level for the same reason as the
// SessionMemory throttles above — they reset on every resolved SessionContext (a
// fresh session starts with zero MC actions).
let idleMicroCompactCount = 0

export function resetSessionScopedCounters(): void {
  sessionMemoryTokensSinceUpdate = 0
  sessionMemoryToolCallsSinceUpdate = 0
  sessionMemoryUpdateCount = 0
  idleMicroCompactCount = 0
}

function currentState(): SessionState {
  return requireSessionContext()
}

function cloneSessionContext(current: SessionState): SessionContext {
  return {
    ...current,
    todos: [...current.todos],
    cliArgRules: [...current.cliArgRules],
    identityRules: [...current.identityRules],
    fileRules: [...current.fileRules],
    activeSkillAllowedTools: current.activeSkillAllowedTools
      ? [...current.activeSkillAllowedTools]
      : undefined,
    backgroundTasks: new Set(current.backgroundTasks),
  }
}

export function snapshotSessionContext(): SessionContext {
  return cloneSessionContext(currentState())
}

export function getSessionId(): string {
  return currentState().sessionId
}

export function getCwd(): string {
  return currentState().cwd
}

export function setCwd(cwd: string): void {
  currentState().cwd = cwd
}

export function getModel(): string {
  return currentState().model
}

export function setModel(model: string): void {
  currentState().model = model
}

export function getSessionsDir(): string {
  return currentState().sessionsDir
}

export function getMemoryDir(): string {
  return currentState().memoryDir
}

export function getCurrentUserId(): string | undefined {
  return currentState().currentUserId
}

export function requireCurrentUserId(): string {
  const userId = currentState().currentUserId
  if (!userId) {
    throw new Error('No LightClaw identity is active for this session.')
  }
  return userId
}

export function setCurrentUserId(userId: string | undefined): void {
  currentState().currentUserId = userId
}

export function getResumedFrom(): string | null {
  return currentState().resumedFrom
}

export function incrementCompactionCount(): number {
  const current = currentState()
  current.compactionCount += 1
  return current.compactionCount
}

export function getCompactionCount(): number {
  return currentState().compactionCount
}

export function getLastExtractedAt(): number {
  return currentState().lastExtractedAt
}

export function setLastExtractedAt(timestamp: number): void {
  currentState().lastExtractedAt = timestamp
}

export function getTodos(): TodoItem[] {
  return [...currentState().todos]
}

export function setTodos(todos: TodoItem[]): void {
  currentState().todos = [...todos]
}

export function getPermissionMode(): PermissionMode {
  return currentState().permissionMode
}

export function setPermissionMode(mode: PermissionMode): void {
  currentState().permissionMode = mode
}

export function getIdentityRules(): PermissionRule[] {
  return [...currentState().identityRules]
}

export function setIdentityRules(rules: PermissionRule[]): void {
  // Replace wholesale — the caller has just reloaded from disk after writing
  // (FeishuPermissionCoordinator / askUserApproval) or revoking. Holding a
  // shared array reference (pre-Phase 17 sessionRulesByUser pattern) is no
  // longer needed.
  currentState().identityRules = [...rules]
}

export function getPermissionApprover(): PermissionApprover | null {
  return currentState().permissionApprover
}

export function setPermissionApprover(approver: PermissionApprover | null): void {
  currentState().permissionApprover = approver
}

export function getChannelFileSender(): ChannelFileSender | null {
  return currentState().channelFileSender
}

export function setChannelFileSender(sender: ChannelFileSender | null): void {
  currentState().channelFileSender = sender
}

export function getCliArgRules(): PermissionRule[] {
  return [...currentState().cliArgRules]
}

export function setCliArgRules(rules: PermissionRule[]): void {
  currentState().cliArgRules = [...rules]
}

export function getFileRules(): PermissionRule[] {
  return [...currentState().fileRules]
}

export function setFileRules(rules: PermissionRule[]): void {
  currentState().fileRules = [...rules]
}

export function getRuntime(): Runtime {
  const runtime = currentState().runtime
  if (!runtime) {
    throw new Error('Runtime has not been initialized. Did initializeApp() complete?')
  }

  return runtime
}

export function getRuntimeIfInitialized(): Runtime | undefined {
  return getCurrentSessionContext()?.runtime
}

export function setRuntime(runtime: Runtime): void {
  currentState().runtime = runtime
}

export function getRuntimePool(): RuntimePool {
  runtimePool ??= new RuntimePool()
  return runtimePool
}

export function getImageReadiness(): ImageReadinessTracker {
  imageReadiness ??= new ImageReadinessTracker()
  return imageReadiness
}

export function getNetworkBridge(): NetworkBridge | null {
  return networkBridge
}

export function setNetworkBridge(bridge: NetworkBridge | null): void {
  networkBridge = bridge
}

export function getAllPermissionRules(): PermissionRule[] {
  const current = currentState()
  // Order does not affect evaluation (deny > ask > allow is enforced inside
  // evaluatePermission regardless of array order), but identity rules go
  // first so they show up at the top of `/rules list`. cli rules next
  // (most ephemeral; tied to the current process), then file rules, then
  // builtin denies — those last two come from loadFileRules in fileRules
  // already concatenated.
  return [
    ...current.identityRules,
    ...current.cliArgRules,
    ...current.fileRules,
  ]
}

export function getActiveSkillAllowedTools(): string[] | undefined {
  const allowedTools = currentState().activeSkillAllowedTools
  return allowedTools ? [...allowedTools] : undefined
}

export function setActiveSkillAllowedTools(allowedTools: string[] | undefined): void {
  currentState().activeSkillAllowedTools = allowedTools ? [...allowedTools] : undefined
}

export function clearActiveSkillAllowedTools(): void {
  currentState().activeSkillAllowedTools = undefined
}

export function getAbortController(): AbortController {
  return currentState().abortController
}

export function resetAbortController(): AbortController {
  const current = currentState()
  current.abortController = new AbortController()
  return current.abortController
}

export function setAbortControllerForUser(
  canonical: string,
  controller: AbortController,
): void {
  abortControllerByUser.set(canonical, controller)
}

/**
 * Abort the most-recently-installed in-flight controller for `canonical`.
 * Returns true if a controller existed and was aborted; false if no entry
 * (user never ran a query) or it was already aborted.
 */
export function abortInFlightForUser(canonical: string): boolean {
  const ctrl = abortControllerByUser.get(canonical)
  if (!ctrl || ctrl.signal.aborted) {
    return false
  }
  ctrl.abort()
  return true
}

export function addUsage(usage: UsageStats): void {
  const current = currentState()
  current.totalInputTokens += usage.input_tokens ?? 0
  current.totalOutputTokens += usage.output_tokens ?? 0
}

export function getUsageTotals(): {
  inputTokens: number
  outputTokens: number
} {
  const current = currentState()
  return {
    inputTokens: current.totalInputTokens,
    outputTokens: current.totalOutputTokens,
  }
}

export function registerBackgroundTask(task: Promise<unknown>): void {
  const current = currentState()
  current.backgroundTasks.add(task)
  void task.finally(() => {
    current.backgroundTasks.delete(task)
  })
}

export async function awaitBackgroundTasks(): Promise<void> {
  const current = currentState()
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

export function getIdleMicroCompactCount(): number {
  return idleMicroCompactCount
}

export function incrementIdleMicroCompactCount(): number {
  idleMicroCompactCount += 1
  return idleMicroCompactCount
}
