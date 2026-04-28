import {
  linkSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

// `linkSync` is atomic — either creates the destination or fails with EEXIST,
// no empty-file window. This is the standard non-flock pattern (see
// proper-lockfile / pid-file) for stdlib-only mutual exclusion: we write the
// PID to a per-process temp file, then `link` it to the canonical path; if
// link fails because the canonical path exists, we inspect the recorded PID,
// reject startup if it's alive, or remove the stale lock and retry. SIGKILL
// leaves a stale PID file, but the next startup detects "no such process" via
// `process.kill(pid, 0)` and reclaims it without admin intervention.
const LOCK_PATH = path.join(homedir(), '.lightclaw', 'lightclaw.pid')
const MAX_ATTEMPTS = 3

export class LightClawAlreadyRunningError extends Error {
  readonly existingPid: number

  constructor(existingPid: number) {
    super(
      `LightClaw is already running (PID ${existingPid}). ` +
      `Stop the existing instance first: kill ${existingPid}`,
    )
    this.name = 'LightClawAlreadyRunningError'
    this.existingPid = existingPid
  }
}

let lockHeld = false
let exitHandlerInstalled = false

export function acquireProcessLock(): void {
  if (lockHeld) {
    return
  }

  mkdirSync(path.dirname(LOCK_PATH), { recursive: true, mode: 0o700 })

  const tempPath = `${LOCK_PATH}.${process.pid}.tmp`
  writeFileSync(tempPath, `${process.pid}\n`, { mode: 0o600 })

  try {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      try {
        linkSync(tempPath, LOCK_PATH)
        lockHeld = true
        installExitHandler()
        return
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error
        }

        const recordedPid = readRecordedPid()
        if (recordedPid !== null && isProcessAlive(recordedPid)) {
          throw new LightClawAlreadyRunningError(recordedPid)
        }

        // The recorded PID is stale (process died, possibly via SIGKILL)
        // or the file is unparseable. Remove and retry; the next iteration
        // either wins the linkSync or finds yet another live owner.
        try {
          unlinkSync(LOCK_PATH)
        } catch {
          // Another process may have already cleaned it; that's fine — the
          // next linkSync will tell us the truth.
        }
      }
    }

    throw new Error(
      `Failed to acquire LightClaw process lock at ${LOCK_PATH} ` +
      `after ${MAX_ATTEMPTS} attempts.`,
    )
  } finally {
    try {
      unlinkSync(tempPath)
    } catch {
      // best-effort cleanup
    }
  }
}

export function releaseProcessLock(): void {
  if (!lockHeld) {
    return
  }
  lockHeld = false
  try {
    unlinkSync(LOCK_PATH)
  } catch {
    // Already removed (e.g. by another process taking over after we crashed
    // and were detected as stale).
  }
}

function readRecordedPid(): number | null {
  try {
    const raw = readFileSync(LOCK_PATH, 'utf8').trim()
    const parsed = parseInt(raw, 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null
  } catch {
    return null
  }
}

function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) {
    return true
  }
  try {
    // Signal 0 doesn't deliver a signal; it just probes whether the process
    // exists. ESRCH = no such process; EPERM = exists but we lack permission
    // (still alive from the lock's perspective).
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function installExitHandler(): void {
  if (exitHandlerInstalled) {
    return
  }
  exitHandlerInstalled = true
  // 'exit' fires on natural termination AND on graceful signal handlers that
  // call process.exit(). It does NOT fire on SIGKILL — that case is handled
  // by stale detection on the next startup.
  process.on('exit', releaseProcessLock)
}
