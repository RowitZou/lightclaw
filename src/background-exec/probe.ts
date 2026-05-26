import { jobFile, EXIT_FILE, KILLED_FILE, LOST_FILE } from './jobdir.js'
import type {
  BackgroundJobEntry,
  BackgroundJobLostReason,
  BackgroundJobMeta,
  BackgroundJobSnapshot,
} from './types.js'

function snapshot(
  meta: BackgroundJobMeta,
  status: BackgroundJobSnapshot['status'],
  extras: Pick<BackgroundJobSnapshot, 'exitCode' | 'endedAt' | 'lostReason'> = {},
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

  // Lost sentinel is stamped by the watcher when it gives up on a pgid; honor
  // it so a re-probe (idempotent) returns the same terminal status the
  // watcher already published.
  const lostContent = await readFileIfExists(entry, jobFile(jobDir, LOST_FILE))
  if (lostContent) {
    return snapshot(meta, 'lost', {
      endedAt: Date.now(),
      lostReason: parseLostReason(lostContent),
    })
  }

  const probe = await runtime.exec({
    command: `kill -0 -- -${meta.pgid} 2>/dev/null`,
    cwd: meta.cwd,
    timeoutMs: 5_000,
    maxBufferBytes: 16 * 1024,
  }).catch(() => null)

  if (!probe) {
    // The probe exec itself failed (control-plane blip, timeout, transient
    // network). We did not actually observe the process group — return
    // 'unknown' so the watcher waits across more ticks before declaring lost.
    // A single blip on a healthy wrapper must not surface as a terminal
    // 'lost' notification to the model.
    return snapshot(meta, 'unknown')
  }

  if (probe.exitCode !== 0) {
    // Narrow race window: process self-exited between the initial exit-file
    // stat (line 38) and `kill -0` returning. The bg-runner wrapper's
    // `printf > exit.tmp && mv exit.tmp exit` may have landed during the
    // probe exec, in which case the job is actually completed — re-check
    // before stamping lost. 2026-05-26 dogfood observed a python3
    // `sleep(2); sys.exit(0)` land both `exit=0` and `lost=probe` on disk
    // for exactly this race. The window is bounded by the wrapper's mv
    // taking SIGCHLD → printf → mv to complete, so one extra stat closes
    // it without paying anything on the healthy path (kill -0 returns 0).
    const lateExit = await readFileIfExists(entry, jobFile(jobDir, EXIT_FILE))
    if (lateExit) {
      const raw = lateExit.toString('utf8').trim()
      const exitCode = Number.parseInt(raw, 10)
      return snapshot(meta, 'completed', {
        exitCode: Number.isFinite(exitCode) ? exitCode : undefined,
        endedAt: Date.now(),
      })
    }
    return snapshot(meta, 'lost', { endedAt: Date.now(), lostReason: 'probe' })
  }

  return snapshot(meta, 'running')
}

const LOST_REASONS: ReadonlySet<BackgroundJobLostReason> = new Set([
  'probe',
  'unknown-grace-exhausted',
  'output-cap-exceeded',
  'wallclock-overrun',
])

function parseLostReason(content: Buffer): BackgroundJobLostReason | undefined {
  const first = content.toString('utf8').split('\n')[0]?.trim()
  return first && (LOST_REASONS as ReadonlySet<string>).has(first)
    ? (first as BackgroundJobLostReason)
    : undefined
}
