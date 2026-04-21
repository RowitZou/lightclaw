import { randomUUID } from 'node:crypto'

import type { TodoItem, UsageStats } from './types.js'

type SessionState = {
  sessionId: string
  cwd: string
  model: string
  sessionsDir: string
  memoryDir: string
  resumedFrom: string | null
  compactionCount: number
  lastExtractedAt: number
  totalInputTokens: number
  totalOutputTokens: number
  todos: TodoItem[]
  abortController: AbortController
  backgroundTasks: Set<Promise<unknown>>
}

let state: SessionState | null = null

export function initializeState(input: {
  cwd: string
  model: string
  sessionsDir: string
  memoryDir: string
  sessionId?: string
  resumedFrom?: string | null
  compactionCount?: number
  lastExtractedAt?: number
  todos?: TodoItem[]
}): void {
  state = {
    sessionId: input.sessionId ?? randomUUID(),
    cwd: input.cwd,
    model: input.model,
    sessionsDir: input.sessionsDir,
    memoryDir: input.memoryDir,
    resumedFrom: input.resumedFrom ?? null,
    compactionCount: input.compactionCount ?? 0,
    lastExtractedAt: input.lastExtractedAt ?? 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    todos: input.todos ?? [],
    abortController: new AbortController(),
    backgroundTasks: new Set(),
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
