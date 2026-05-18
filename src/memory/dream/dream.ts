import { runSubagent } from '../../agents/run-subagent.js'
import type { LightClawConfig } from '../../config.js'
import { createAutoDreamCanUseTool } from '../auto-mem-can-use-tool.js'
import { ensureMemoryDir } from '../auto-memory.js'
import { isExtractionInProgressFor } from '../extract.js'
import {
  markConsolidationSucceeded,
  readLastConsolidatedAt,
  rollbackConsolidationLock,
  tryAcquireConsolidationLock,
} from './lock.js'
import { buildDreamPrompt, gatherDreamMemoryTree } from './prompt.js'
import { gatherDreamSessions } from './sessions.js'

type DreamState = {
  inProgressByUser: Set<string>
  inFlight: Set<Promise<void>>
  lastSessionScanAtByUser: Map<string, number>
}

const state: DreamState = {
  inProgressByUser: new Set(),
  inFlight: new Set(),
  lastSessionScanAtByUser: new Map(),
}

// Test seam: dream.test.ts replaces the subagent runner with a fake so
// gate-pass / rollback / success paths are exercised without a real LLM call.
type RunSubagentFn = typeof runSubagent
let runSubagentImpl: RunSubagentFn = runSubagent

export function setRunSubagentForTest(impl: RunSubagentFn | null): void {
  runSubagentImpl = impl ?? runSubagent
}

export async function executeAutoDream(params: {
  userId: string
  memoryDir: string
  config: LightClawConfig
  currentSessionId: string
}): Promise<void> {
  if (!params.config.memory.extractor.enabled || !params.config.memory.curator.enabled) {
    return
  }

  if (
    state.inProgressByUser.has(params.userId) ||
    isExtractionInProgressFor(params.memoryDir)
  ) {
    return
  }

  const task = executeAutoDreamInner(params)
  state.inFlight.add(task)
  // Track completion separately. `.catch` here consumes the rejection so a
  // failed dream does not surface as an unhandledRejection — the caller
  // still sees the original error via `await task`.
  task
    .finally(() => {
      state.inFlight.delete(task)
    })
    .catch(() => {})
  return task
}

async function executeAutoDreamInner(params: {
  userId: string
  memoryDir: string
  config: LightClawConfig
  currentSessionId: string
}): Promise<void> {
  state.inProgressByUser.add(params.userId)
  try {
    await ensureMemoryDir(params.memoryDir)
    const lastConsolidatedAt = await readLastConsolidatedAt(params.memoryDir)
    const elapsedHours = (Date.now() - lastConsolidatedAt) / (60 * 60 * 1000)
    if (lastConsolidatedAt !== 0 && elapsedHours < params.config.memory.curator.minHours) {
      return
    }

    const now = Date.now()
    const lastScanAt = state.lastSessionScanAtByUser.get(params.userId) ?? 0
    if (
      lastScanAt !== 0 &&
      now - lastScanAt < params.config.memory.curator.scanThrottleMs
    ) {
      return
    }

    state.lastSessionScanAtByUser.set(params.userId, now)
    const sessionIds = await gatherDreamSessions({
      userId: params.userId,
      lastConsolidatedAt,
      excludeSessionId: params.currentSessionId,
    })
    if (sessionIds.length < params.config.memory.curator.minSessions) {
      return
    }

    const priorMtime = await tryAcquireConsolidationLock(params.memoryDir)
    if (priorMtime === null) {
      return
    }

    try {
      // Run through the Role pathway (kind='internal'). The fork
      // gets a focused systemPrompt (no Available Skills section) and a
      // tools array containing only MemoryRead / MemoryWriteAt / MemoryMove /
      // MemoryDelete / Read / Grep / Glob. Runtime gate stays as
      // createAutoDreamCanUseTool for defense-in-depth.
      const result = await runSubagentImpl({
        agentType: 'memoryCurator',
        prompt: buildDreamPrompt({
          memoryDir: params.memoryDir,
          transcriptDir: params.config.paths.sessions,
          sessionIds,
          memoryTree: await gatherDreamMemoryTree(params.memoryDir),
        }),
        canUseToolOverride: createAutoDreamCanUseTool(params.memoryDir),
        canonicalUserOverride: params.userId,
        maxTurnsOverride: params.config.memory.curator.maxTurns,
      })
      // WorkerFailure (PR1.6): runSubagent now returns failures as
      // {kind:'failure', envelope} instead of throwing. For autoDream the
      // distinction matters: if the subagent didn't actually consolidate
      // (max-turns / aborted / tool-unavailable), do NOT mark the
      // consolidation as succeeded — that would burn the 24h throttle window
      // even though nothing was committed. Roll back the lock so the next
      // eligible turn can try again, and surface the failure so a calling
      // drain can log it.
      if (result.kind === 'failure') {
        await rollbackConsolidationLock(params.memoryDir, priorMtime)
        const { reason, message } = result.envelope
        console.error(`[auto-dream] subagent failed (${reason}): ${message}`)
        return
      }
      await markConsolidationSucceeded(params.memoryDir)
    } catch (error) {
      await rollbackConsolidationLock(params.memoryDir, priorMtime)
      throw error
    }
  } finally {
    state.inProgressByUser.delete(params.userId)
  }
}

export async function drainPendingDream(timeoutMs = 60_000): Promise<void> {
  if (state.inFlight.size === 0) {
    return
  }
  const TIMEOUT = Symbol('drain-timeout')
  await Promise.race([
    Promise.allSettled([...state.inFlight]),
    new Promise<typeof TIMEOUT>(resolve =>
      setTimeout(() => resolve(TIMEOUT), timeoutMs).unref(),
    ),
  ])
}

export function resetAutoDreamStateForTest(): void {
  state.inProgressByUser.clear()
  state.inFlight.clear()
  state.lastSessionScanAtByUser.clear()
}

export function getAutoDreamInFlightCountForTest(): number {
  return state.inFlight.size
}
