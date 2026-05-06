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
