import { randomUUID } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import path from 'node:path'

import { shellQuote } from '../runtime/process.js'
import { loadMeta, mutateMeta } from '../session/storage.js'
import type { Runtime } from '../runtime/index.js'

/**
 * Per-sessionId working-directory tracking behind the Bash tool's "working
 * directory persists between calls" contract.
 *
 * Every exec is still a stateless subprocess (nothing here touches the
 * runtime backends). Persistence is Claude Code's mechanism: append a
 * `pwd -P > <probe file>` to the user command, read the probe back after the
 * exec, and start the next command with a `cd` to the recorded directory.
 * The probe goes to a file — not stdout — because the rlaunch capture
 * pipeline truncates stdout with `head -c`, which would eat a trailing
 * marker exactly on the large-output commands.
 *
 * State lives in an in-process map keyed by sessionId (the session lock
 * serializes same-session Bash calls, so there is no write race) and is
 * mirrored to session meta.json best-effort so a daemon restart / TaskRun
 * resume keeps the directory. The meta mirror only updates an EXISTING
 * meta.json — sessions the storage layer doesn't know (ephemeral worker
 * contexts) stay memory-only rather than growing stray session dirs.
 */

const cwdBySession = new Map<string, string>()

/** Directory the next Bash command for this session should start from. */
export async function resolveTrackedCwd(
  sessionId: string,
  workspaceRoot: string,
): Promise<string> {
  const inMemory = cwdBySession.get(sessionId)
  if (inMemory) {
    return inMemory
  }
  try {
    const persisted = (await loadMeta(sessionId))?.bashCwd
    if (persisted && path.posix.isAbsolute(persisted)) {
      cwdBySession.set(sessionId, persisted)
      return persisted
    }
  } catch {
    // Meta read failures degrade to the workspace root.
  }
  cwdBySession.set(sessionId, workspaceRoot)
  return workspaceRoot
}

export async function updateTrackedCwd(
  sessionId: string,
  cwd: string,
): Promise<void> {
  cwdBySession.set(sessionId, cwd)
  try {
    await mutateMeta(sessionId, current =>
      current ? { ...current, bashCwd: cwd } : null,
    )
  } catch {
    // Best-effort mirror; the in-memory value still serves this process.
  }
}

export function buildCwdProbePath(
  workspaceRoot: string,
  canonicalUser: string | undefined,
): string {
  // Same scratch namespace as the rlaunch exec capture files, so the
  // inbox-aging 6h TTL sweep reaps stragglers from a daemon crash mid-exec.
  const prefix = (canonicalUser ?? 'session').replace(/[^A-Za-z0-9_-]/g, '_')
  return path.posix.join(
    workspaceRoot,
    '.lightclaw/exec',
    `${prefix}-${randomUUID()}.cwd`,
  )
}

/**
 * Wrap a user command so it starts from `cwd` and records its final working
 * directory. Transparent for the command itself: stdout/stderr flow
 * unchanged and the exit code is preserved. When the tracked directory no
 * longer exists (deleted by a previous command, container-local path lost to
 * a sandbox restart) the command falls back to the workspace root with one
 * stderr line so the model sees the reset instead of a confusing cd error.
 */
export function wrapCommandWithCwdProbe(input: {
  command: string
  cwd: string
  workspaceRoot: string
  probeFile: string
}): string {
  const probeDir = path.posix.dirname(input.probeFile)
  const prelude =
    input.cwd === input.workspaceRoot
      ? ''
      : `cd ${shellQuote(input.cwd)} 2>/dev/null || { echo ${shellQuote(
          `lightclaw: previous working directory ${input.cwd} no longer exists; running from the workspace root`,
        )} >&2; cd ${shellQuote(input.workspaceRoot)}; }\n`
  return (
    prelude +
    `{ ${input.command}\n}\n` +
    `__lc_cwd_rc=$?\n` +
    `{ mkdir -p ${shellQuote(probeDir)} && pwd -P > ${shellQuote(input.probeFile)}; } 2>/dev/null\n` +
    `exit "$__lc_cwd_rc"`
  )
}

/**
 * Read the probe the wrapped command left behind and delete it. Returns null
 * when the probe is unreadable (command killed before the probe ran, relay
 * hiccup) — callers keep the previous tracked cwd, which is always safe.
 */
export async function collectCwdProbe(
  runtime: Runtime,
  probeFile: string,
): Promise<string | null> {
  let hostPath: string | null = null
  try {
    hostPath = runtime.paths.toHostPath(probeFile)
  } catch {
    hostPath = null
  }
  try {
    const raw = hostPath
      ? await fsp.readFile(hostPath, 'utf8')
      : (await runtime.fs.readFile(probeFile)).toString('utf8')
    const cwd = raw.trim()
    return cwd && path.posix.isAbsolute(cwd) ? cwd : null
  } catch {
    return null
  } finally {
    if (hostPath) {
      await fsp.rm(hostPath, { force: true }).catch(() => {})
    }
  }
}

export function _resetTrackedCwdForTest(): void {
  cwdBySession.clear()
}
