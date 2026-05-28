import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

const LOCK_FILENAME = '.consolidate-lock'
const HOLDER_STALE_MS = 60 * 60 * 1000

/** Dream sub-tasks tracked independently in the lock file. Each one has its
 *  own `lastSuccessAt` so a sub-task that failed (e.g. skillConsolidator
 *  tripping the codex TTFB watchdog) keeps being eligible for retry while
 *  the ones that did succeed (memoryCurator) honor the `minHours` throttle.
 *  Pre-2026-05-27 the lock was a single timestamp covering all three, so a
 *  permanent skillConsolidator failure was masked behind every cycle's
 *  memoryCurator success — the bug Bug 1a from the 2026-05-27 dogfood.
 *  `skillAging` (added 2026-05-28) is the deterministic skill-aging janitor
 *  — it reuses the same per-sub-task throttle so it fires at most once per
 *  `minHours` like the LLM passes, but runs no subagent. */
export type SubTaskName =
  | 'memoryCurator'
  | 'skillCurator'
  | 'skillConsolidator'
  | 'skillAging'

export const SUB_TASK_NAMES: readonly SubTaskName[] = [
  'memoryCurator',
  'skillCurator',
  'skillConsolidator',
  'skillAging',
] as const

/** v2 lock file shape (JSON, one line). `pid` is undefined when no daemon
 *  currently holds the lock (released-on-shutdown or never acquired). */
export type ConsolidationLockState = {
  pid?: number
  subTasks: Partial<Record<SubTaskName, number>>
}

/** Snapshot returned by a successful acquire. Caller never needs to look
 *  inside; it exists as an opaque rollback handle. */
export type AcquireResult = {
  priorSubTasks: Partial<Record<SubTaskName, number>>
}

export function consolidationLockPath(memoryDir: string): string {
  return path.join(memoryDir, LOCK_FILENAME)
}

type RawReadResult = {
  state: ConsolidationLockState | null
  mtimeMs: number
}

async function readLockState(memoryDir: string): Promise<RawReadResult> {
  const lockFile = consolidationLockPath(memoryDir)
  try {
    const [stats, raw] = await Promise.all([stat(lockFile), readFile(lockFile, 'utf8')])
    const trimmed = raw.trim()
    if (trimmed === '') {
      // Released-on-shutdown form. Pre-PR1 this was the only way to keep the
      // pre-restart watermark — we preserved file mtime via utimes. Migrate
      // that legacy mtime into all sub-tasks so a v1 daemon's last-known good
      // run carries forward to v2.
      return {
        state: { subTasks: legacyMtimeAsAllSubTasks(stats.mtimeMs) },
        mtimeMs: stats.mtimeMs,
      }
    }
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed) as Partial<ConsolidationLockState>
        const subTasks = normalizeSubTasks(parsed.subTasks)
        return {
          state: {
            pid: typeof parsed.pid === 'number' ? parsed.pid : undefined,
            subTasks,
          },
          mtimeMs: stats.mtimeMs,
        }
      } catch {
        // Fall through to legacy parse: a corrupted JSON file is treated as
        // a legacy plain-pid file so the next acquire reclaims it cleanly.
      }
    }
    const parsedPid = Number.parseInt(trimmed, 10)
    return {
      state: {
        pid: Number.isFinite(parsedPid) ? parsedPid : undefined,
        subTasks: legacyMtimeAsAllSubTasks(stats.mtimeMs),
      },
      mtimeMs: stats.mtimeMs,
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { state: null, mtimeMs: 0 }
    }
    throw error
  }
}

function legacyMtimeAsAllSubTasks(mtimeMs: number): Partial<Record<SubTaskName, number>> {
  // Pre-PR1 a single lock mtime stood in for "all sub-tasks last succeeded
  // here". The first cycle after upgrade may over-throttle one or two sub-
  // tasks until per-sub-task records overwrite this; that's strictly safer
  // than the alternative (0 across the board, which would fire memoryCurator
  // again immediately after restart and waste tokens).
  return {
    memoryCurator: mtimeMs,
    skillCurator: mtimeMs,
    skillConsolidator: mtimeMs,
    skillAging: mtimeMs,
  }
}

function normalizeSubTasks(
  raw: Partial<Record<SubTaskName, number>> | undefined,
): Partial<Record<SubTaskName, number>> {
  if (!raw || typeof raw !== 'object') return {}
  const out: Partial<Record<SubTaskName, number>> = {}
  for (const name of SUB_TASK_NAMES) {
    const value = raw[name]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      out[name] = value
    }
  }
  return out
}

/** Coarse "did we do anything recently" signal — max of every recorded
 *  sub-task lastSuccessAt. Returns 0 when no lock file or no sub-task has
 *  ever recorded success. */
export async function readLastConsolidatedAt(memoryDir: string): Promise<number> {
  const { state } = await readLockState(memoryDir)
  if (state === null) return 0
  const values = Object.values(state.subTasks).filter(
    (v): v is number => typeof v === 'number',
  )
  if (values.length === 0) return 0
  return Math.max(...values)
}

/** Per-sub-task lastSuccessAt for the minHours gate. Returns 0 when this
 *  sub-task has never recorded a success in this user's memory dir (treat
 *  as "due immediately"). */
export async function readSubTaskLastSuccess(
  memoryDir: string,
  subTask: SubTaskName,
): Promise<number> {
  const { state } = await readLockState(memoryDir)
  return state?.subTasks[subTask] ?? 0
}

/** Earliest sub-task lastSuccessAt across all three — used as the
 *  "since when do we need to look at new sessions" watermark. Returns 0
 *  when any sub-task has never recorded success (scan everything). */
export async function readEarliestSubTaskSuccess(memoryDir: string): Promise<number> {
  const { state } = await readLockState(memoryDir)
  if (state === null) return 0
  for (const name of SUB_TASK_NAMES) {
    if (state.subTasks[name] === undefined) return 0
  }
  const values = SUB_TASK_NAMES.map(name => state.subTasks[name] as number)
  return Math.min(...values)
}

export async function tryAcquireConsolidationLock(
  memoryDir: string,
): Promise<AcquireResult | null> {
  const lockFile = consolidationLockPath(memoryDir)
  await mkdir(memoryDir, { recursive: true })

  const { state: current, mtimeMs } = await readLockState(memoryDir)
  const priorSubTasks: Partial<Record<SubTaskName, number>> = current?.subTasks ?? {}

  if (current && current.pid !== undefined) {
    const lockAgeMs = Date.now() - mtimeMs
    if (lockAgeMs < HOLDER_STALE_MS && isProcessRunning(current.pid)) {
      return null
    }
  }
  // Stale-pid / released-no-pid / corrupted-legacy path: unlink so the wx-flag
  // writeFile below races safely against concurrent acquirers. A live held
  // lock returned `null` above before reaching this unlink. ENOENT is fine
  // (raced with another reclaimer).
  if (current) {
    try {
      await unlink(lockFile)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    }
  }

  const newState: ConsolidationLockState = {
    pid: process.pid,
    subTasks: priorSubTasks,
  }
  try {
    await writeFile(lockFile, JSON.stringify(newState) + '\n', { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return null
    }
    throw error
  }

  const verification = await readLockState(memoryDir)
  if (!verification.state || verification.state.pid !== process.pid) {
    return null
  }

  return { priorSubTasks }
}

/** Restore the lock to its pre-acquire sub-task snapshot and clear our pid.
 *  Called only from the catch arm in dream.ts when the outer try{} threw
 *  before any sub-task could record success. Successful sub-task marks
 *  inside the try{} have already overwritten priorSubTasks via
 *  markSubTaskSucceeded — those persist; rollback only reverts the failed
 *  partial state. Best-effort: never throws across shutdown / unmount. */
export async function rollbackConsolidationLock(
  memoryDir: string,
  prior: AcquireResult,
): Promise<void> {
  const lockFile = consolidationLockPath(memoryDir)
  try {
    const { state: current } = await readLockState(memoryDir)
    const restored: ConsolidationLockState = {
      // Preserve any sub-task marks that DID succeed before the exception;
      // overlay priorSubTasks underneath as a safety net for the never-marked
      // names (so the file always has the legacy or prior watermark).
      subTasks: { ...prior.priorSubTasks, ...(current?.subTasks ?? {}) },
    }
    await writeFile(lockFile, JSON.stringify(restored) + '\n')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[auto-dream] rollback failed: ${message}`)
  }
}

/** Record that one sub-task just finished successfully. The other sub-tasks
 *  are untouched. Idempotent within a single dream cycle (later calls just
 *  overwrite the timestamp). */
export async function markSubTaskSucceeded(
  memoryDir: string,
  subTask: SubTaskName,
): Promise<void> {
  const { state: current } = await readLockState(memoryDir)
  const next: ConsolidationLockState = {
    pid: current?.pid ?? process.pid,
    subTasks: { ...(current?.subTasks ?? {}), [subTask]: Date.now() },
  }
  await writeFile(consolidationLockPath(memoryDir), JSON.stringify(next) + '\n')
}

/** Drop this process's pid from the lock file at shutdown without losing
 *  the per-sub-task lastSuccessAt watermark. Without this, a clean exit
 *  leaves the lock carrying our (now-dead) pid; the next start's
 *  `tryAcquireConsolidationLock` would still reclaim correctly, but the
 *  reclaim path unlinks the file which would erase our subTasks history if
 *  not for this explicit release. Idempotent and best-effort: never throws
 *  across shutdown, and ignores locks held by a different pid (concurrent
 *  daemons under the same memoryDir is an unsupported configuration;
 *  releasing someone else's pid would be worse than leaving it). */
export async function releaseConsolidationLockOwnership(memoryDir: string): Promise<void> {
  const lockFile = consolidationLockPath(memoryDir)
  try {
    const { state: current } = await readLockState(memoryDir)
    if (!current || current.pid !== process.pid) return
    const released: ConsolidationLockState = { subTasks: current.subTasks }
    await writeFile(lockFile, JSON.stringify(released) + '\n')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    // best-effort during shutdown drain — never throw
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
