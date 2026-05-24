import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'

import { getAllAgents } from '../../agents/registry.js'
import { runSubagent } from '../../agents/run-subagent.js'
import type { AgentType, Role } from '../../agents/types.js'
import type { LightClawConfig } from '../../config.js'
import { listActiveCanonicalUsers } from '../../identity/store.js'
import { ensureMemoryDir, getMemoryDir } from '../auto-memory.js'
import {
  isExtractionInProgressFor,
  onExtractSettled,
} from '../extract.js'
import {
  markConsolidationSucceeded,
  readLastConsolidatedAt,
  releaseConsolidationLockOwnership,
  rollbackConsolidationLock,
  tryAcquireConsolidationLock,
} from './lock.js'
import {
  buildDreamPrompt,
  buildSkillConsolidatorPrompt,
  buildSkillCuratorPrompt,
  gatherDreamMemoryTree,
  gatherDreamUserSkillsFull,
  gatherDreamVisibleSkills,
} from './prompt.js'
import { gatherDreamSessions } from './sessions.js'

type AutoDreamParams = {
  userId: string
  memoryDir: string
  config: LightClawConfig
  currentSessionId: string
}

type DreamState = {
  inProgressByUser: Set<string>
  inFlight: Set<Promise<void>>
  lastSessionScanAtByUser: Map<string, number>
  /** Users whose dream attempt was deferred because extract was still in
   *  flight when the hook tried to fire. The next `onExtractSettled`
   *  callback for that user's memoryDir re-fires `executeAutoDream` so dream
   *  catches the first quiet window without waiting for another turn-end
   *  hook to retrigger. Dedup is automatic (Map keyed by userId): N pending
   *  requests for the same user collapse to one (dream is per-canonical-user
   *  idempotent within the 24h gate window, so multiple pending = identical
   *  intent). Latest params win so retry uses the most recent
   *  currentSessionId.
   *  Cleared in `executeAutoDream` the moment the outer gate accepts — even
   *  if inner gates (minHours / minSessions / lock) subsequently bail, we
   *  don't loop: the next turn-end hook will re-stash if work remains. */
  pendingByUser: Map<string, AutoDreamParams>
}

const state: DreamState = {
  inProgressByUser: new Set(),
  inFlight: new Set(),
  lastSessionScanAtByUser: new Map(),
  pendingByUser: new Map(),
}

// Register at module load: every time an extract task clears its
// in-progress key, check if any pending dream's user matches the settled
// memoryDir AND that user has no other extract still in flight. If so,
// retry. This is the mechanism that breaks the "extract is always running →
// dream's outer gate always bails" deadlock observed in 2026-05-18 dogfood
// (0 memoryCurator runs across 92 memoryExtractor runs).
//
// queueMicrotask defers the registration until after all module bodies
// finish executing. The dream → run-subagent → dispatched-agent → query →
// hook-registry → hooks/auto-memory → dream import chain forms a cycle
// that leaves extract.ts mid-initialization (hoisted function visible,
// `extractSettledListeners` const still in TDZ) when dream.ts's module body
// first runs. Calling `onExtractSettled` synchronously here would throw
// ReferenceError. The microtask runs after the cycle unwinds and all consts
// are initialized.
queueMicrotask(() => {
  onExtractSettled(settledMemoryDir => {
    if (state.pendingByUser.size === 0) {
      return
    }
    // Snapshot to avoid mutation-during-iteration when retries re-stash.
    const pending = [...state.pendingByUser.entries()]
    for (const [userId, params] of pending) {
      if (params.memoryDir !== settledMemoryDir) {
        continue
      }
      if (state.inProgressByUser.has(userId)) {
        continue
      }
      if (isExtractionInProgressFor(params.memoryDir)) {
        continue
      }
      void executeAutoDream(params).catch(() => {})
    }
  })
})

// Test seam: dream.test.ts replaces the subagent runner with a fake so
// gate-pass / rollback / success paths are exercised without a real LLM call.
type RunSubagentFn = typeof runSubagent
let runSubagentImpl: RunSubagentFn = runSubagent

export function setRunSubagentForTest(impl: RunSubagentFn | null): void {
  runSubagentImpl = impl ?? runSubagent
}

export async function executeAutoDream(params: AutoDreamParams): Promise<void> {
  if (!params.config.memory.extractor.enabled || !params.config.memory.curator.enabled) {
    return
  }

  if (
    state.inProgressByUser.has(params.userId) ||
    isExtractionInProgressFor(params.memoryDir)
  ) {
    // Stash so the next onExtractSettled callback for this memoryDir can
    // retry without waiting for another turn-end hook. Dedup is automatic;
    // see DreamState.pendingByUser comment.
    state.pendingByUser.set(params.userId, params)
    return
  }
  // Accepted past the outer gate. Clear the pending flag now (not on
  // success): if inner gates bail (minHours / minSessions / lock), the next
  // turn-end hook will re-stash if needed, and we avoid a tight retry loop
  // where every settle event re-fires a dream that minHours instantly bails.
  state.pendingByUser.delete(params.userId)

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
      // minHours is a steady-state throttle. A burst of extractor output in a
      // single window — a night of heavy background dispatch produced 50+ new
      // memory files in the 2026-05-20 dogfood — would otherwise sit
      // un-curated for a full 24h. Bypass the throttle when enough new memory
      // files have landed since the last consolidation that duplication is
      // likely. `burstFileThreshold: 0` disables the bypass. The shorter
      // `scanThrottleMs` gate still applies below, so a burst cannot make the
      // curator run more than once per scan window.
      const burstThreshold = params.config.memory.curator.burstFileThreshold
      const isBurst =
        burstThreshold > 0
        && (await countMemoriesModifiedSince(params.memoryDir, lastConsolidatedAt))
          >= burstThreshold
      if (!isBurst) {
        return
      }
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
      // Run through the Role pathway (kind='internal'). The Role's
      // `tools` list (MemoryRead / MemoryWriteAt / MemoryMove /
      // MemoryDelete / Read / Grep / Glob) is the single source of truth
      // for what this subagent can use — runtime gate is the default
      // `deriveCanUseTool(role)` applied by runSubagent.
      let memoryCuratorSucceeded = false
      try {
        const result = await runSubagentImpl({
          agentType: 'memoryCurator',
          prompt: buildDreamPrompt({
            memoryDir: params.memoryDir,
            transcriptDir: params.config.paths.sessions,
            sessionIds,
            memoryTree: await gatherDreamMemoryTree(params.memoryDir),
          }),
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
          const { reason, message } = result.envelope
          console.error(`[auto-dream] memoryCurator failed (${reason}): ${message}`)
        } else {
          memoryCuratorSucceeded = true
        }
      } catch (error) {
        console.error(`[auto-dream] memoryCurator failed: ${errorMessage(error)}`)
      }
      await runSkillDreamPasses({
        userId: params.userId,
        cwd: process.cwd(),
        sessionsDir: params.config.paths.sessions,
        sessionIds,
        lastConsolidatedAt,
        maxTurns: params.config.memory.curator.maxTurns,
      })
      if (memoryCuratorSucceeded) {
        await markConsolidationSucceeded(params.memoryDir)
      } else {
        await rollbackConsolidationLock(params.memoryDir, priorMtime)
      }
    } catch (error) {
      await rollbackConsolidationLock(params.memoryDir, priorMtime)
      throw error
    }
  } finally {
    state.inProgressByUser.delete(params.userId)
  }
}

async function runSkillDreamPasses(params: {
  userId: string
  cwd: string
  sessionsDir: string
  sessionIds: string[]
  lastConsolidatedAt: number
  maxTurns?: number
}): Promise<void> {
  const workerRoles = getAllAgents()
    .filter(role => role.kind === 'worker')
    .sort((left, right) => String(left.agentType).localeCompare(String(right.agentType)))

  for (const role of workerRoles) {
    const transcriptPaths = await gatherForkTranscriptPathsForRole({
      sessionsDir: params.sessionsDir,
      sessionIds: params.sessionIds,
      role,
      since: params.lastConsolidatedAt,
    })
    if (transcriptPaths.length === 0) {
      continue
    }
    try {
      const result = await runSubagentImpl({
        agentType: 'skillCurator',
        prompt: buildSkillCuratorPrompt({
          userId: params.userId,
          role,
          transcriptPaths,
          visibleSkills: await gatherDreamVisibleSkills({
            cwd: params.cwd,
            userId: params.userId,
            role,
          }),
        }),
        canonicalUserOverride: params.userId,
        maxTurnsOverride: params.maxTurns,
      })
      logDreamSubagentFailure('skillCurator', result)
    } catch (error) {
      console.error(`[auto-dream] skillCurator failed for ${role.agentType}: ${errorMessage(error)}`)
    }
  }

  try {
    const result = await runSubagentImpl({
      agentType: 'skillConsolidator',
      prompt: buildSkillConsolidatorPrompt({
        userId: params.userId,
        userSkills: await gatherDreamUserSkillsFull({
          cwd: params.cwd,
          userId: params.userId,
        }),
      }),
      canonicalUserOverride: params.userId,
      maxTurnsOverride: params.maxTurns,
    })
    logDreamSubagentFailure('skillConsolidator', result)
  } catch (error) {
    console.error(`[auto-dream] skillConsolidator failed: ${errorMessage(error)}`)
  }
}

async function gatherForkTranscriptPathsForRole(params: {
  sessionsDir: string
  sessionIds: string[]
  role: Role
  since: number
}): Promise<string[]> {
  const paths: string[] = []
  const prefix = `${params.role.agentType}-`
  for (const sessionId of params.sessionIds) {
    const forksDir = path.join(params.sessionsDir, sessionId, 'forks')
    let entries
    try {
      entries = await readdir(forksDir, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue
      }
      throw error
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith('.jsonl')) {
        continue
      }
      const filePath = path.join(forksDir, entry.name)
      if (params.since !== 0) {
        const fileStat = await stat(filePath)
        if (fileStat.mtimeMs <= params.since) {
          continue
        }
      }
      paths.push(filePath)
    }
  }
  return paths.sort((left, right) => left.localeCompare(right))
}

function logDreamSubagentFailure(agentType: AgentType, result: Awaited<ReturnType<RunSubagentFn>>): void {
  if (result.kind === 'failure') {
    const { reason, message } = result.envelope
    console.error(`[auto-dream] ${agentType} failed (${reason}): ${message}`)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Count `.md` memory files in the user-level root and every role-private
 * subdirectory whose mtime is newer than `since`. `_shared/` (curator-owned
 * output) and `archive/` (the aging-eviction sink) are excluded — this counts
 * only the tiers extractors write to. It stats files instead of parsing
 * frontmatter so a large tree stays cheap on the curator gate path.
 */
async function countMemoriesModifiedSince(
  memoryDir: string,
  since: number,
): Promise<number> {
  const dirsToScan = [memoryDir]
  try {
    for (const entry of await readdir(memoryDir, { withFileTypes: true })) {
      if (
        entry.isDirectory()
        && entry.name !== '_shared'
        && entry.name !== 'archive'
        && !entry.name.startsWith('.')
      ) {
        dirsToScan.push(path.join(memoryDir, entry.name))
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 0
    }
    throw error
  }

  let count = 0
  for (const dir of dirsToScan) {
    try {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (
          !entry.isFile()
          || !entry.name.endsWith('.md')
          || entry.name === 'MEMORY.md'
        ) {
          continue
        }
        const fileStat = await stat(path.join(dir, entry.name))
        if (fileStat.mtimeMs > since) {
          count += 1
        }
      }
    } catch {
      // Directory unreadable or a file vanished mid-scan — skip it. An
      // occasional undercount is harmless for a threshold check.
    }
  }
  return count
}

/** Walk every paired canonical user's memoryDir and release any consolidate
 *  lock this process still holds. Called from shutdown drains so the lock
 *  file no longer carries our (about-to-die) pid — the next start gets a
 *  clean empty-file acquire that preserves the prior `lastConsolidatedAt`
 *  watermark instead of resetting `minHours` to "now". See
 *  `releaseConsolidationLockOwnership` for the rationale. Best-effort: a
 *  failure here must not block the rest of the shutdown sequence. */
export async function releaseConsolidationLocksOnShutdown(
  config: LightClawConfig,
): Promise<void> {
  let users: string[]
  try {
    users = await listActiveCanonicalUsers()
  } catch {
    return
  }
  await Promise.allSettled(
    users.map(user => releaseConsolidationLockOwnership(getMemoryDir(user, config))),
  )
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
  state.pendingByUser.clear()
}

export function getAutoDreamPendingCountForTest(): number {
  return state.pendingByUser.size
}

export function getAutoDreamInFlightCountForTest(): number {
  return state.inFlight.size
}
