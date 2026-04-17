import { randomUUID } from 'node:crypto'

import type { UsageStats } from './types.js'

type SessionState = {
  sessionId: string
  cwd: string
  model: string
  sessionsDir: string
  resumedFrom: string | null
  compactionCount: number
  totalInputTokens: number
  totalOutputTokens: number
  abortController: AbortController
}

let state: SessionState | null = null

export function initializeState(input: {
  cwd: string
  model: string
  sessionsDir: string
  sessionId?: string
  resumedFrom?: string | null
  compactionCount?: number
}): void {
  state = {
    sessionId: input.sessionId ?? randomUUID(),
    cwd: input.cwd,
    model: input.model,
    sessionsDir: input.sessionsDir,
    resumedFrom: input.resumedFrom ?? null,
    compactionCount: input.compactionCount ?? 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    abortController: new AbortController(),
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