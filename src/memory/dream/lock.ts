import { mkdir, readFile, stat, unlink, utimes, writeFile } from 'node:fs/promises'
import path from 'node:path'

const LOCK_FILENAME = '.consolidate-lock'
const HOLDER_STALE_MS = 60 * 60 * 1000

export function consolidationLockPath(memoryDir: string): string {
  return path.join(memoryDir, LOCK_FILENAME)
}

export async function readLastConsolidatedAt(memoryDir: string): Promise<number> {
  try {
    const stats = await stat(consolidationLockPath(memoryDir))
    return stats.mtimeMs
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 0
    }
    throw error
  }
}

export async function tryAcquireConsolidationLock(
  memoryDir: string,
): Promise<number | null> {
  const lockFile = consolidationLockPath(memoryDir)
  await mkdir(memoryDir, { recursive: true })

  const current = await readLockFile(lockFile)
  if (current) {
    const lockAgeMs = Date.now() - current.mtimeMs
    if (lockAgeMs < HOLDER_STALE_MS && current.pid && isProcessRunning(current.pid)) {
      return null
    }

    try {
      await unlink(lockFile)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    }
  }

  try {
    await writeFile(lockFile, `${process.pid}\n`, { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return null
    }
    throw error
  }

  const verification = await readLockFile(lockFile)
  if (!verification || verification.pid !== process.pid) {
    return null
  }

  return current?.mtimeMs ?? 0
}

export async function rollbackConsolidationLock(
  memoryDir: string,
  priorMtime: number,
): Promise<void> {
  const lockFile = consolidationLockPath(memoryDir)
  try {
    if (priorMtime === 0) {
      await unlink(lockFile)
      return
    }

    await writeFile(lockFile, '')
    const timestamp = priorMtime / 1000
    await utimes(lockFile, timestamp, timestamp)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[auto-dream] rollback failed: ${message}`)
  }
}

export async function markConsolidationSucceeded(memoryDir: string): Promise<void> {
  await writeFile(consolidationLockPath(memoryDir), `${process.pid}\n`)
}

/** Drop this process's pid from the lock file at shutdown without losing the
 *  `lastConsolidatedAt` watermark. Without this, a clean exit leaves the lock
 *  carrying our (now-dead) pid; `tryAcquireConsolidationLock` on the next
 *  start would detect the stale-pid case and reclaim, but the reclaim path
 *  unlinks + recreates the file, resetting mtime to the acquire moment and
 *  erasing the real last-consolidation timestamp — so the `minHours` throttle
 *  starts counting from restart instead of from the prior successful dream.
 *  Clearing the holder (writeFile '') while preserving mtime via utimes keeps
 *  the watermark intact and turns the next start's acquire into a no-conflict
 *  empty-file path. Idempotent and best-effort: never throws across shutdown,
 *  and ignores locks held by a different pid (concurrent daemons under the
 *  same memoryDir is an unsupported configuration; releasing someone else's
 *  pid would be worse than leaving it). */
export async function releaseConsolidationLockOwnership(memoryDir: string): Promise<void> {
  const lockFile = consolidationLockPath(memoryDir)
  try {
    const current = await readLockFile(lockFile)
    if (!current || current.pid !== process.pid) return
    const mtimeSeconds = current.mtimeMs / 1000
    await writeFile(lockFile, '')
    await utimes(lockFile, mtimeSeconds, mtimeSeconds)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    // best-effort during shutdown drain — never throw
  }
}

async function readLockFile(
  lockFile: string,
): Promise<{ mtimeMs: number; pid: number | undefined } | null> {
  try {
    const [stats, raw] = await Promise.all([stat(lockFile), readFile(lockFile, 'utf8')])
    const parsed = Number.parseInt(raw.trim(), 10)
    return {
      mtimeMs: stats.mtimeMs,
      pid: Number.isFinite(parsed) ? parsed : undefined,
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
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
