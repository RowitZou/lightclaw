import { randomUUID } from 'node:crypto'

import type { UsageStats } from './types.js'

type SessionState = {
  sessionId: string
  cwd: string
  model: string
  totalInputTokens: number
  totalOutputTokens: number
  abortController: AbortController
}

let state: SessionState | null = null

export function initializeState(input: { cwd: string; model: string }): void {
  state = {
    sessionId: randomUUID(),
    cwd: input.cwd,
    model: input.model,
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