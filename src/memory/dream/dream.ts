import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'

import { getAllAgents } from '../../agents/registry.js'
import { runSubagent } from '../../agents/run-subagent.js'
import type { AgentType, Role } from '../../agents/types.js'
import type { LightClawConfig, RuntimeDriver } from '../../config.js'
import { userSessionsRoot, userSkillsRoot } from '../../identity/paths.js'
import { listActiveCanonicalUsers } from '../../identity/store.js'
import { ageUserSkills } from '../../skill/skill-aging.js'
import { ensureMemoryDir, getMemoryDir } from '../auto-memory.js'
import {
  isExtractionInProgressFor,
  onExtractSettled,
} from '../extract.js'
import {
  type AcquireResult,
  markSubTaskSucceeded,
  readEarliestSubTaskSuccess,
  readSubTaskLastSuccess,
  releaseConsolidationLockOwnership,
  rollbackConsolidationLock,
  type SubTaskName,
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
        logRetryAttempt(userId, 'skip-dream-in-flight')
        continue
      }
      if (isExtractionInProgressFor(params.memoryDir)) {
        // The 2026-05-27 dogfood Bug 1b suspicion: under heavy concurrent
        // extract load this branch fires repeatedly while a sibling extract
        // is still running, leaving pendingByUser unable to drain. This
        // stderr line is what would surface that pattern in the next
        // dogfood — grep for "skip-extract-in-flight" frequency.
        logRetryAttempt(userId, 'skip-extract-in-flight')
        continue
      }
      logRetryAttempt(userId, 'fired')
      void executeAutoDream(params).catch(() => {})
    }
  })
})

function logOuterGate(
  userId: string,
  reason: 'disabled' | 'dream-in-flight' | 'extract-in-flight',
): void {
  // Diagnostic-only (PR2, 2026-05-27). Bug 1b from the 2026-05-27 dogfood
  // ("first autoDream took 11h to fire") could not be attributed from the
  // existing stderr stream because every gated turn returned silently. Each
  // bail now prints one line so the next dogfood can grep the cause without
  // re-instrumenting. `pending=<n>` is the post-bail pendingByUser size —
  // when this stays high across many turns under "extract-in-flight" the
  // suspicion is confirmed (the retry hook can't drain through the queue).
  console.error(
    `[auto-dream] gated user=${userId} reason=${reason} pending=${state.pendingByUser.size}`,
  )
}

function logRetryAttempt(
  userId: string,
  result: 'fired' | 'skip-dream-in-flight' | 'skip-extract-in-flight',
): void {
  console.error(
    `[auto-dream] retry-attempt user=${userId} result=${result} pending=${state.pendingByUser.size}`,
  )
}

// PR3 (2026-05-28). PR2 covered the outer gate (executeAutoDream entry).
// The inner gates inside executeAutoDreamInner — minHours throttling, scan
// throttle, minSessions, lock-held — used to bail silently. The 2026-05-28
// dogfood saw `retry-attempt fired` followed by NO sub-task activity at all,
// which on inspection was a silent minSessions bail (only feishu:group had
// activity since the legacy lock watermark; current DM excluded). The next
// dogfood that hits any inner-gate bail should grep one of these lines
// instead of having to reason from sessions/* mtimes vs. lock mtime.
function logInnerGate(
  userId: string,
  reason: 'min-hours-all-throttled' | 'scan-throttle' | 'min-sessions' | 'lock-held',
  detail: string,
): void {
  console.error(
    `[auto-dream] inner-gated user=${userId} reason=${reason} ${detail}`,
  )
}

function dueShape(due: SubTaskDueMap): string {
  const parts: string[] = []
  if (due.memoryCurator) parts.push('mc')
  if (due.skillCurator) parts.push('sc')
  if (due.skillConsolidator) parts.push('sco')
  if (due.skillAging) parts.push('sa')
  return parts.length === 0 ? 'none' : parts.join('+')
}

// Test seam: dream.test.ts replaces the subagent runner with a fake so
// gate-pass / rollback / success paths are exercised without a real LLM call.
type RunSubagentFn = typeof runSubagent
let runSubagentImpl: RunSubagentFn = runSubagent

export function setRunSubagentForTest(impl: RunSubagentFn | null): void {
  runSubagentImpl = impl ?? runSubagent
}

export async function executeAutoDream(params: AutoDreamParams): Promise<void> {
  if (!params.config.memory.extractor.enabled || !params.config.memory.curator.enabled) {
    logOuterGate(params.userId, 'disabled')
    return
  }

  const dreamInFlight = state.inProgressByUser.has(params.userId)
  const extractInFlight = isExtractionInProgressFor(params.memoryDir)
  if (dreamInFlight || extractInFlight) {
    // Stash so the next onExtractSettled callback for this memoryDir can
    // retry without waiting for another turn-end hook. Dedup is automatic;
    // see DreamState.pendingByUser comment.
    state.pendingByUser.set(params.userId, params)
    logOuterGate(
      params.userId,
      dreamInFlight ? 'dream-in-flight' : 'extract-in-flight',
    )
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

    // PR1 (2026-05-27): each sub-task has its own minHours throttle so a
    // permanent skillConsolidator failure stays retryable while
    // memoryCurator honors the 24h cap. Pre-PR1 a single lock mtime gated
    // all three, so a TTFB failure on skillConsolidator was masked behind
    // memoryCurator's success forever — Bug 1a from the 2026-05-27 dogfood.
    const subTaskDue = await computeSubTaskDue(params.memoryDir, params.config)
    if (
      !subTaskDue.memoryCurator &&
      !subTaskDue.skillCurator &&
      !subTaskDue.skillConsolidator &&
      !subTaskDue.skillAging
    ) {
      // No sub-task is due. Burst bypass still applies — a night of heavy
      // extractor output (2026-05-20 dogfood: 50+ files in one window)
      // should not sit un-curated for the full minHours window.
      const burstThreshold = params.config.memory.curator.burstFileThreshold
      const watermark = await readEarliestSubTaskSuccess(params.memoryDir)
      const burstCount = burstThreshold > 0
        ? await countMemoriesModifiedSince(params.memoryDir, watermark)
        : 0
      const isBurst = burstThreshold > 0 && burstCount >= burstThreshold
      if (!isBurst) {
        logInnerGate(params.userId, 'min-hours-all-throttled',
          `burst=${burstCount}/${burstThreshold}`)
        return
      }
      // Burst overrides minHours, but only for the curator side
      // (memoryCurator is what dedupes new extractor output). Skill
      // sub-tasks still honor their own throttles.
      subTaskDue.memoryCurator = true
    }

    const now = Date.now()
    const lastScanAt = state.lastSessionScanAtByUser.get(params.userId) ?? 0
    if (
      lastScanAt !== 0 &&
      now - lastScanAt < params.config.memory.curator.scanThrottleMs
    ) {
      const ageMs = now - lastScanAt
      logInnerGate(params.userId, 'scan-throttle',
        `age=${Math.round(ageMs / 1000)}s window=${Math.round(params.config.memory.curator.scanThrottleMs / 1000)}s`)
      return
    }

    state.lastSessionScanAtByUser.set(params.userId, now)
    const sessionWatermark = await readEarliestSubTaskSuccess(params.memoryDir)
    const sessionIds = await gatherDreamSessions({
      userId: params.userId,
      lastConsolidatedAt: sessionWatermark,
      excludeSessionId: params.currentSessionId,
    })
    if (sessionIds.length < params.config.memory.curator.minSessions) {
      logInnerGate(params.userId, 'min-sessions',
        `sessions=${sessionIds.length}/${params.config.memory.curator.minSessions}`
        + ` due=${dueShape(subTaskDue)}`)
      return
    }

    const prior = await tryAcquireConsolidationLock(params.memoryDir)
    if (prior === null) {
      logInnerGate(params.userId, 'lock-held', 'another daemon or in-progress dream holds the lock')
      return
    }

    try {
      // Run through the Role pathway (kind='internal'). The Role's
      // `tools` list (MemoryRead / MemoryWriteAt / MemoryMove /
      // MemoryDelete / Read / Grep / Glob) is the single source of truth
      // for what this subagent can use — runtime gate is the default
      // `deriveCanUseTool(role)` applied by runSubagent.
      if (subTaskDue.memoryCurator) {
        const memoryCuratorSucceeded = await runMemoryCurator({
          memoryDir: params.memoryDir,
          transcriptDir: userSessionsRoot(params.userId),
          sessionIds,
          userId: params.userId,
          maxTurns: params.config.memory.curator.maxTurns,
        })
        if (memoryCuratorSucceeded) {
          await markSubTaskSucceeded(params.memoryDir, 'memoryCurator')
        }
      }

      // Skill sub-tasks are independently due-gated. skillCurator's per-role
      // pass uses its own watermark (own lastSuccessAt) so a sub-task that
      // failed on a previous cycle scans fork transcripts since that prior
      // attempt instead of inheriting memoryCurator's just-updated stamp.
      const skillCuratorLastSuccess = await readSubTaskLastSuccess(
        params.memoryDir,
        'skillCurator',
      )
      const skillConsolidatorLastSuccess = await readSubTaskLastSuccess(
        params.memoryDir,
        'skillConsolidator',
      )
      const skillOutcome = await runSkillDreamPasses({
        userId: params.userId,
        cwd: process.cwd(),
        sessionsDir: userSessionsRoot(params.userId),
        sessionIds,
        skillCuratorLastSuccess,
        runSkillCurator: subTaskDue.skillCurator,
        runSkillConsolidator: subTaskDue.skillConsolidator,
        runtimeDriver: params.config.runtime?.driver ?? null,
        maxTurns: params.config.memory.curator.maxTurns,
      })
      if (subTaskDue.skillCurator
        && (skillOutcome.skillCuratorSucceeded || skillOutcome.skillCuratorNoOp)) {
        // No-op also marks success: with nothing to curate this cycle, leaving
        // lastSuccessAt at 0 would re-fire the gate every turn forever. Treat
        // "scanned and found nothing" as legitimate completion.
        await markSubTaskSucceeded(params.memoryDir, 'skillCurator')
      }
      if (subTaskDue.skillConsolidator && skillOutcome.skillConsolidatorSucceeded) {
        await markSubTaskSucceeded(params.memoryDir, 'skillConsolidator')
      }

      // skillAging is deterministic (no subagent). It runs after the LLM skill
      // passes so the consolidator gets first crack at merging; running both
      // under the same consolidation lock keeps the user's skill dir free of
      // archive-vs-merge write races.
      if (subTaskDue.skillAging && (await runSkillAging(params.userId))) {
        await markSubTaskSucceeded(params.memoryDir, 'skillAging')
      }
      await releaseConsolidationLockOwnership(params.memoryDir)
    } catch (error) {
      await rollbackConsolidationLock(params.memoryDir, prior)
      throw error
    }
  } finally {
    state.inProgressByUser.delete(params.userId)
  }
}

type SubTaskDueMap = Record<SubTaskName, boolean>

async function computeSubTaskDue(
  memoryDir: string,
  config: LightClawConfig,
): Promise<SubTaskDueMap> {
  const minHoursMs = config.memory.curator.minHours * 60 * 60 * 1000
  const now = Date.now()
  async function isDue(name: SubTaskName): Promise<boolean> {
    const last = await readSubTaskLastSuccess(memoryDir, name)
    if (last === 0) return true
    return now - last >= minHoursMs
  }
  return {
    memoryCurator: await isDue('memoryCurator'),
    skillCurator: await isDue('skillCurator'),
    skillConsolidator: await isDue('skillConsolidator'),
    skillAging: await isDue('skillAging'),
  }
}

async function runMemoryCurator(params: {
  memoryDir: string
  transcriptDir: string
  sessionIds: string[]
  userId: string
  maxTurns?: number
}): Promise<boolean> {
  try {
    const result = await runSubagentImpl({
      agentType: 'memoryCurator',
      prompt: buildDreamPrompt({
        memoryDir: params.memoryDir,
        transcriptDir: params.transcriptDir,
        sessionIds: params.sessionIds,
        memoryTree: await gatherDreamMemoryTree(params.memoryDir),
      }),
      canonicalUserOverride: params.userId,
      maxTurnsOverride: params.maxTurns,
    })
    // WorkerFailure (PR1.6): runSubagent returns failures as
    // {kind:'failure', envelope}. For autoDream the distinction matters: if
    // memoryCurator didn't actually consolidate (max-turns / aborted /
    // tool-unavailable), do NOT mark its lastSuccessAt — that would burn
    // the per-sub-task throttle window even though nothing was committed.
    if (result.kind === 'failure') {
      const { reason, message } = result.envelope
      console.error(`[auto-dream] memoryCurator failed (${reason}): ${message}`)
      return false
    }
    return true
  } catch (error) {
    console.error(`[auto-dream] memoryCurator failed: ${errorMessage(error)}`)
    return false
  }
}

/** Deterministic skill aging pass. Returns true when it completed (so the
 *  caller advances the skillAging watermark), false on an unexpected error so
 *  the next due window retries. Most passes archive / purge nothing — that is
 *  still a successful completion. */
async function runSkillAging(userId: string): Promise<boolean> {
  try {
    const result = await ageUserSkills(userSkillsRoot(userId), userId)
    const touched = result.archived.length + result.purged.length
    if (touched > 0) {
      console.error(
        `[auto-dream] skillAging user=${userId} archived=${result.archived.length} purged=${result.purged.length}`,
      )
    }
    return true
  } catch (error) {
    console.error(`[auto-dream] skillAging failed: ${errorMessage(error)}`)
    return false
  }
}

type SkillDreamOutcome = {
  // Aggregate skillCurator success across every worker role that had new
  // fork transcripts to process this cycle. Any single failure flips the
  // flag false so the per-sub-task lock stays open for retry on the next
  // due window — a failed coder skillCurator should not be hidden behind
  // a successful localExplorer pass.
  skillCuratorSucceeded: boolean
  // True only when no worker role had new fork transcripts AND the caller
  // asked us to run skillCurator. Distinguishes "nothing to do this cycle"
  // from "ran and at least one failed". Both leave lastSuccessAt unchanged,
  // but only the first should be silent in logs.
  skillCuratorNoOp: boolean
  skillConsolidatorSucceeded: boolean
}

async function runSkillDreamPasses(params: {
  userId: string
  cwd: string
  sessionsDir: string
  sessionIds: string[]
  skillCuratorLastSuccess: number
  runSkillCurator: boolean
  runSkillConsolidator: boolean
  runtimeDriver: RuntimeDriver
  maxTurns?: number
}): Promise<SkillDreamOutcome> {
  let skillCuratorSucceeded = true
  let skillCuratorRanForAtLeastOneRole = false
  let skillConsolidatorSucceeded = false

  if (params.runSkillCurator) {
    const workerRoles = getAllAgents()
      .filter(role => role.kind === 'worker')
      .sort((left, right) => String(left.agentType).localeCompare(String(right.agentType)))

    for (const role of workerRoles) {
      const transcriptPaths = await gatherForkTranscriptPathsForRole({
        sessionsDir: params.sessionsDir,
        sessionIds: params.sessionIds,
        role,
        since: params.skillCuratorLastSuccess,
      })
      if (transcriptPaths.length === 0) {
        continue
      }
      skillCuratorRanForAtLeastOneRole = true
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
              runtimeDriver: params.runtimeDriver,
            }),
          }),
          canonicalUserOverride: params.userId,
          maxTurnsOverride: params.maxTurns,
        })
        if (result.kind === 'failure') {
          logDreamSubagentFailure('skillCurator', result)
          skillCuratorSucceeded = false
        }
      } catch (error) {
        console.error(`[auto-dream] skillCurator failed for ${role.agentType}: ${errorMessage(error)}`)
        skillCuratorSucceeded = false
      }
    }
  }

  if (params.runSkillConsolidator) {
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
      if (result.kind === 'failure') {
        logDreamSubagentFailure('skillConsolidator', result)
      } else {
        skillConsolidatorSucceeded = true
      }
    } catch (error) {
      console.error(`[auto-dream] skillConsolidator failed: ${errorMessage(error)}`)
    }
  }

  return {
    skillCuratorSucceeded: skillCuratorSucceeded && skillCuratorRanForAtLeastOneRole,
    skillCuratorNoOp: params.runSkillCurator && !skillCuratorRanForAtLeastOneRole,
    skillConsolidatorSucceeded,
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
