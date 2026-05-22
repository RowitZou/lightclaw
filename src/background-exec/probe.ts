import { jobFile, EXIT_FILE, KILLED_FILE } from './jobdir.js'
import type { BackgroundJobEntry, BackgroundJobMeta, BackgroundJobSnapshot } from './types.js'

function snapshot(
  meta: BackgroundJobMeta,
  status: BackgroundJobSnapshot['status'],
  extras: Pick<BackgroundJobSnapshot, 'exitCode' | 'endedAt'> = {},
): BackgroundJobSnapshot {
  return {
    jobId: meta.jobId,
    status,
    startedAt: meta.startedAt,
    command: meta.command,
    outFile: meta.outFile,
    errFile: meta.errFile,
    ...extras,
  }
}

async function readFileIfExists(entry: BackgroundJobEntry, pathname: string): Promise<Buffer | null> {
  try {
    await entry.runtime.fs.stat(pathname)
    return await entry.runtime.fs.readFile(pathname)
  } catch {
    return null
  }
}

export async function probeBackgroundJob(entry: BackgroundJobEntry): Promise<BackgroundJobSnapshot> {
  const { meta, runtime } = entry
  const jobDir = meta.outFile.slice(0, meta.outFile.length - '/out'.length)

  const exitContent = await readFileIfExists(entry, jobFile(jobDir, EXIT_FILE))
  if (exitContent) {
    const raw = exitContent.toString('utf8').trim()
    const exitCode = Number.parseInt(raw, 10)
    return snapshot(meta, 'completed', {
      exitCode: Number.isFinite(exitCode) ? exitCode : undefined,
      endedAt: Date.now(),
    })
  }

  const killedContent = await readFileIfExists(entry, jobFile(jobDir, KILLED_FILE))
  if (killedContent) {
    return snapshot(meta, 'killed', { endedAt: Date.now() })
  }

  const probe = await runtime.exec({
    command: `kill -0 -- -${meta.pgid} 2>/dev/null`,
    cwd: meta.cwd,
    timeoutMs: 5_000,
    maxBufferBytes: 16 * 1024,
  }).catch(() => null)

  if (!probe || probe.exitCode !== 0) {
    return snapshot(meta, 'lost', { endedAt: Date.now() })
  }

  return snapshot(meta, 'running')
}
