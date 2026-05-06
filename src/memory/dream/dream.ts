import { getLastCacheSafeParams } from '../../agents/cache-safe-params.js'
import { runForkedAgent } from '../../agents/forked-agent.js'
import type { LightClawConfig } from '../../config.js'
import { createAutoMemCanUseTool } from '../auto-mem-can-use-tool.js'
import { ensureMemoryDir } from '../auto-memory.js'
import { isExtractionInProgress } from '../extract.js'
import {
  markConsolidationSucceeded,
  readLastConsolidatedAt,
  rollbackConsolidationLock,
  tryAcquireConsolidationLock,
} from './lock.js'
import { buildDreamPrompt } from './prompt.js'
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

export async function executeAutoDream(params: {
  userId: string
  memoryDir: string
  config: LightClawConfig
  currentSessionId: string
}): Promise<void> {
  if (!params.config.autoMemory || !params.config.autoDream.enabled) {
    return
  }

  if (state.inProgressByUser.has(params.userId) || isExtractionInProgress()) {
    return
  }

  const task = executeAutoDreamInner(params)
  state.inFlight.add(task)
  void task.finally(() => {
    state.inFlight.delete(task)
  })
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
    if (lastConsolidatedAt !== 0 && elapsedHours < params.config.autoDream.minHours) {
      return
    }

    const now = Date.now()
    const lastScanAt = state.lastSessionScanAtByUser.get(params.userId) ?? 0
    if (
      lastScanAt !== 0 &&
      now - lastScanAt < params.config.autoDream.scanThrottleMs
    ) {
      return
    }

    state.lastSessionScanAtByUser.set(params.userId, now)
    const sessionIds = await gatherDreamSessions({
      userId: params.userId,
      lastConsolidatedAt,
      excludeSessionId: params.currentSessionId,
    })
    if (sessionIds.length < params.config.autoDream.minSessions) {
      return
    }

    const cacheSafeParams = getLastCacheSafeParams()
    if (!cacheSafeParams) {
      console.error('[auto-dream] no cacheSafeParams available, skipping')
      return
    }

    const priorMtime = await tryAcquireConsolidationLock(params.memoryDir)
    if (priorMtime === null) {
      return
    }

    try {
      const abortController = new AbortController()
      await runForkedAgent({
        promptText: buildDreamPrompt({
          memoryDir: params.memoryDir,
          transcriptDir: params.config.sessionsDir,
          sessionIds,
        }),
        cacheSafeParams,
        canUseTool: createAutoMemCanUseTool(params.memoryDir),
        maxTurns: params.config.autoDream.maxTurns,
        label: 'auto_dream',
        signal: abortController.signal,
      })
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
