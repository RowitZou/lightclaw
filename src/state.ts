import { randomUUID } from 'node:crypto'

import type {
  PermissionApprover,
  PermissionMode,
  PermissionRule,
} from './permission/types.js'
import { ImageReadinessTracker } from './runtime/image-readiness.js'
import type { NetworkBridge } from './runtime/network-bridge.js'
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
  /**
   * Per-canonical-user persisted allow/deny/ask rules (mirrors the on-disk
   * `<lightclawHome>/identity/per-user/<canonical>/permissions.json` file).
   * Rebuilt from disk on every initializeState / resetSessionContext, so the
   * Feishu coordinator's "以后都允许" path can write the file and reload here
   * without juggling an in-memory map. Empty for terminal sessions without
   * a paired identity.
   */
  identityRules: PermissionRule[]
  fileRules: PermissionRule[]
  activeSkillAllowedTools?: string[]
  /**
   * Channel-injected permission approver (Feishu card / future channels).
   * Set once per query() entry by ChannelRunner so that ANY tool call —
   * main agent or subagent — routes through the same UX. Subagent paths no
   * longer auto-deny on `ask`; they read this approver via getPermission-
   * Approver(). Terminal sessions leave it null and fall back to readline.
   */
  permissionApprover: PermissionApprover | null
  abortController: AbortController
  backgroundTasks: Set<Promise<unknown>>
  runtime?: Runtime
}

let state: SessionState | null = null
let runtimePool: RuntimePool | null = null
let imageReadiness: ImageReadinessTracker | null = null
let networkBridge: NetworkBridge | null = null
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
  identityRules?: PermissionRule[]
  fileRules?: PermissionRule[]
  runtime?: Runtime
}): void {
  // Preserve the channel-injected approver across resetSessionContext —
  // ChannelRunner sets it before each query() and clearing it here would
  // strand subagent permission requests with no UX path.
  const preservedApprover = state?.permissionApprover ?? null
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
    identityRules: input.identityRules ?? [],
    fileRules: input.fileRules ?? [],
    activeSkillAllowedTools: undefined,
    permissionApprover: preservedApprover,
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

export function getIdentityRules(): PermissionRule[] {
  return [...requireState().identityRules]
}

export function setIdentityRules(rules: PermissionRule[]): void {
  // Replace wholesale — the caller has just reloaded from disk after writing
  // (FeishuPermissionCoordinator / askUserApproval) or revoking. Holding a
  // shared array reference (pre-Phase 17 sessionRulesByUser pattern) is no
  // longer needed.
  requireState().identityRules = [...rules]
}

export function getPermissionApprover(): PermissionApprover | null {
  return state?.permissionApprover ?? null
}

export function setPermissionApprover(approver: PermissionApprover | null): void {
  // Tolerate state-not-yet-initialized so the channel runner's `finally`
  // block can safely clear the approver even when resetSessionContext threw
  // before establishing state. No-op in that case (no state to leak from).
  if (state) {
    state.permissionApprover = approver
  }
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

export function getNetworkBridge(): NetworkBridge | null {
  return networkBridge
}

export function setNetworkBridge(bridge: NetworkBridge | null): void {
  networkBridge = bridge
}

export function getAllPermissionRules(): PermissionRule[] {
  const current = requireState()
  // Order does not affect evaluation (deny > ask > allow is enforced inside
  // evaluatePermission regardless of array order), but identity rules go
  // first so they show up at the top of `/permissions list`. cli rules next
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
