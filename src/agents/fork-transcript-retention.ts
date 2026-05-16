import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000
const DEFAULT_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000
const STAMP_FILE = '.last-fork-sweep'

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

  await Promise.all(sessionEntries
    .filter(entry => entry.isDirectory())
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

export async function maybeSweepForkTranscripts(
  sessionsDir: string,
  input?: {
    ttlMs?: number
    sweepIntervalMs?: number
    now?: number
  },
): Promise<{ skipped: boolean; deleted: number }> {
  const now = input?.now ?? Date.now()
  const stampPath = path.join(sessionsDir, STAMP_FILE)
  try {
    const raw = await readFile(stampPath, 'utf8')
    const lastSweep = Number(raw.trim())
    if (
      Number.isFinite(lastSweep)
      && now - lastSweep < (input?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS)
    ) {
      return { skipped: true, deleted: 0 }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }

  const { deleted } = await sweepStaleForkTranscripts(
    sessionsDir,
    input?.ttlMs ?? DEFAULT_TTL_MS,
    now,
  )
  await mkdir(sessionsDir, { recursive: true })
  await writeFile(stampPath, `${now}\n`, 'utf8')
  return { skipped: false, deleted }
}
