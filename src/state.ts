import { randomUUID } from 'node:crypto'

import type { PermissionMode, PermissionRule } from './permission/types.js'
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
    sessionRules: [],
    fileRules: input.fileRules ?? [],
    activeSkillAllowedTools: undefined,
    abortController: new AbortController(),
    backgroundTasks: new Set(),
    runtime: input.runtime,
  }
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
  requireState().sessionRules.push(rule)
}

export function clearSessionRules(): void {
  requireState().sessionRules = []
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
