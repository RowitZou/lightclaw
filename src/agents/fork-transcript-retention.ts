import { mkdir, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000
const DEFAULT_EPHEMERAL_TTL_MS = 72 * 60 * 60 * 1000
const DEFAULT_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000
const STAMP_FILE = '.last-fork-sweep'
const EPHEMERAL_SESSION_PREFIXES = ['bg-', 'dispatched-'] as const

function isEphemeralSessionDir(name: string): boolean {
  return EPHEMERAL_SESSION_PREFIXES.some(prefix => name.startsWith(prefix))
}

export async function sweepStaleForkTranscripts(
  sessionsDir: string,
  ttlMs = DEFAULT_TTL_MS,
  now = Date.now(),
): Promise<{ deleted: number }> {
  let deleted = 0
  let sessionEntries
  try {
    sessionEntries = await readdir(sessionsDir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { deleted }
    }
    throw error
  }

  // Ephemeral session dirs are wholesale-managed by sweepEphemeralSessionDirs;
  // skipping them here keeps the two passes orthogonal so the file sweep can't
  // race the directory removal and an active ephemeral worker can't have its
  // forks/ swept out from under it on the rare path where a fork transcript's
  // mtime drifts past 7d while the worker is still writing.
  await Promise.all(sessionEntries
    .filter(entry => entry.isDirectory() && !isEphemeralSessionDir(entry.name))
    .map(async entry => {
      const forksDir = path.join(sessionsDir, entry.name, 'forks')
      let forkEntries
      try {
        forkEntries = await readdir(forksDir, { withFileTypes: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return
        }
        throw error
      }

      await Promise.all(forkEntries
        .filter(fork => fork.isFile() && fork.name.endsWith('.jsonl'))
        .map(async fork => {
          const filePath = path.join(forksDir, fork.name)
          const stats = await stat(filePath)
          if (now - stats.mtimeMs <= ttlMs) {
            return
          }
          await unlink(filePath)
          deleted += 1
        }))
    }))

  return { deleted }
}

export async function sweepEphemeralSessionDirs(
  sessionsDir: string,
  ttlMs = DEFAULT_EPHEMERAL_TTL_MS,
  now = Date.now(),
  activeSessionIds: ReadonlySet<string> = new Set(),
): Promise<{ removed: number }> {
  let removed = 0
  let entries
  try {
    entries = await readdir(sessionsDir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { removed }
    }
    throw error
  }

  await Promise.all(entries
    .filter(entry => entry.isDirectory() && isEphemeralSessionDir(entry.name))
    .filter(entry => !activeSessionIds.has(entry.name))
    .map(async entry => {
      const dirPath = path.join(sessionsDir, entry.name)
      const stats = await stat(dirPath)
      if (now - stats.mtimeMs <= ttlMs) {
        return
      }
      await rm(dirPath, { recursive: true, force: true })
      removed += 1
    }))

  return { removed }
}

export async function maybeSweepForkTranscripts(
  sessionsDir: string,
  input?: {
    ttlMs?: number
    ephemeralTtlMs?: number
    sweepIntervalMs?: number
    activeSessionIds?: ReadonlySet<string>
    now?: number
  },
): Promise<{ skipped: boolean; deleted: number; ephemeralRemoved: number }> {
  const now = input?.now ?? Date.now()
  const stampPath = path.join(sessionsDir, STAMP_FILE)
  try {
    const raw = await readFile(stampPath, 'utf8')
    const lastSweep = Number(raw.trim())
    if (
      Number.isFinite(lastSweep)
      && now - lastSweep < (input?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS)
    ) {
      return { skipped: true, deleted: 0, ephemeralRemoved: 0 }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }

  const ephemeralResult = await sweepEphemeralSessionDirs(
    sessionsDir,
    input?.ephemeralTtlMs ?? DEFAULT_EPHEMERAL_TTL_MS,
    now,
    input?.activeSessionIds,
  )
  const { deleted } = await sweepStaleForkTranscripts(
    sessionsDir,
    input?.ttlMs ?? DEFAULT_TTL_MS,
    now,
  )
  await mkdir(sessionsDir, { recursive: true })
  await writeFile(stampPath, `${now}\n`, 'utf8')
  return { skipped: false, deleted, ephemeralRemoved: ephemeralResult.removed }
}
