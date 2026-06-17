import {
  clampPermissionMode,
  type PermissionApprover,
  type PermissionMode,
  type PermissionRule,
} from './permission/types.js'
import { getConfig, type LightClawConfig } from './config.js'
import { ImageReadinessTracker } from './runtime/image-readiness.js'
import { LocalRuntime } from './runtime/local.js'
import type { NetworkBridge } from './runtime/network-bridge.js'
import { RuntimePool } from './runtime/pool.js'
import type { Runtime } from './runtime/index.js'
import { lightclawHome } from './paths.js'
import type { Role } from './agents/types.js'
import {
  getCurrentSessionContext,
  requireSessionContext,
  type ChannelFileSender,
  type SessionContext,
} from './session-context.js'
import type { TodoItem, UsageStats } from './types.js'

// Channel-specific cleanup hooks that need to run when a sessionId is aborted
// (e.g. AskUserQuestion's pending card teardown). Channels register their hook
// at startup and dispose on shutdown so state.ts stays unaware of channel
// internals. Hooks are best-effort and must not throw.
type SessionAbortHook = (sessionId: string) => void | Promise<void>
const sessionAbortHooks = new Set<SessionAbortHook>()

export function registerSessionAbortHook(hook: SessionAbortHook): () => void {
  sessionAbortHooks.add(hook)
  return () => {
    sessionAbortHooks.delete(hook)
  }
}

type SessionState = SessionContext

let runtimePool: RuntimePool | null = null
let daemonLocalRuntime: Runtime | null = null
let imageReadiness: ImageReadinessTracker | null = null
let networkBridge: NetworkBridge | null = null
// Keyed by sessionId — Phase 26 formula `feishu:dm:<chatId>` /
// `feishu:group:<chatId>[:<threadId>]:<senderOpenId>` for channel sessions,
// and the terminal session id for the REPL. `/stop` must therefore target
// the same sessionId the inbound message resolves to so a `/stop` typed in
// a group never aborts the DM session's in-flight turn (or vice versa).
const abortControllerBySession = new Map<string, AbortController>()
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
    backgroundTasks: new Set(current.backgroundTasks),
    enabledSecrets: current.enabledSecrets
      ? new Map(current.enabledSecrets)
      : undefined,
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

export function getCurrentRole(): Role | undefined {
  return currentState().currentRole
}

export function getCurrentChainState(): import('./signal-bus/chain-state.js').ChainState | undefined {
  return currentState().chainState
}

export function getCurrentTaskRunId(): string | undefined {
  return currentState().currentTaskRunId
}

/** The chat/sender a created cloud resource (Feishu doc) should be shared with.
 *  Set per inbound channel message; inherited down a dispatch chain via the
 *  childCtx spread. Read at Dispatch time so a background fire can carry the
 *  originating group's chatId into its own fresh SessionContext — without it,
 *  a doc created inside a background worker is granted only to the bot and
 *  group members get 403 (see background-task/runner.ts createSessionContext). */
export function getResourceGrantTarget(): import('./session-context.js').ResourceGrantTarget | undefined {
  return getCurrentSessionContext()?.resourceGrantTarget
}

/** TaskUpdate deliver marks the current handling as having concluded a run
 *  (a root closed / a run delivered). The channel runner reads this to send a
 *  synthetic-wake final block to chat. Tolerant + best-effort — never throw on
 *  a missing context (a routing-quality signal must not break the turn). */
export function markConcludedRootThisTurn(): void {
  const ctx = getCurrentSessionContext()
  if (ctx) ctx.concludedRootThisTurn = true
}

export function didConcludeRootThisTurn(): boolean {
  return getCurrentSessionContext()?.concludedRootThisTurn === true
}

export function getCurrentUserId(): string | undefined {
  return currentState().currentUserId
}

export function getSessionConfig(): LightClawConfig {
  return getCurrentSessionContext()?.config ?? getConfig()
}

const EMPTY_ENABLED_SECRETS: ReadonlyMap<string, string> = new Map<string, string>()

export function getCurrentEnabledSecrets(): ReadonlyMap<string, string> {
  return getCurrentSessionContext()?.enabledSecrets ?? EMPTY_ENABLED_SECRETS
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
  const state = currentState()
  return clampPermissionMode(state.permissionMode, state.permissionCeiling)
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

/**
 * Process-wide host-direct runtime for framework-internal roles
 * (memoryExtractor / memoryCurator). Their entire working set — the user's
 * memory tree and session transcripts — lives daemon-side, so their
 * environment-domain tools (Glob / Grep / Read, which route through
 * `runtime.exec` / `runtime.fs`) must run against the daemon filesystem.
 * Inheriting the triggering turn's sandbox runtime (Docker / Rlaunch) makes
 * those tools blind, since the sandbox mounts the user workspace, not the
 * memory / sessions dirs. `runDispatchedAgent` pins this onto the
 * SessionContext of every `kind: 'internal'` dispatch. Lazily created;
 * `workspaceRoot` is only a fallback cwd — internal-role tools always pass
 * absolute paths.
 */
export function getDaemonLocalRuntime(): Runtime {
  daemonLocalRuntime ??= new LocalRuntime(lightclawHome())
  return daemonLocalRuntime
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

export function getAbortController(): AbortController {
  return currentState().abortController
}

export function resetAbortController(): AbortController {
  const current = currentState()
  current.abortController = new AbortController()
  return current.abortController
}

export function setAbortControllerForSession(
  sessionId: string,
  controller: AbortController,
): void {
  abortControllerBySession.set(sessionId, controller)
}

/**
 * Abort the most-recently-installed in-flight controller for `sessionId`.
 * Returns true if a controller existed and was aborted; false if no entry
 * (no in-flight turn for that session) or it was already aborted.
 */
export function abortInFlightForSession(sessionId: string): boolean {
  const ctrl = abortControllerBySession.get(sessionId)
  if (!ctrl || ctrl.signal.aborted) {
    return false
  }
  ctrl.abort()
  for (const hook of sessionAbortHooks) {
    void Promise.resolve()
      .then(() => hook(sessionId))
      .catch(error => {
        const detail = error instanceof Error ? error.message : String(error)
        process.stderr.write(`[state] session abort hook failed for ${sessionId}: ${detail}\n`)
      })
  }
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
