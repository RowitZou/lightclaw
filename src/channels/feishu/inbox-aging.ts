import { promises as fs } from 'node:fs'
import path from 'node:path'

import { listActiveCanonicalUsers } from '../../identity/store.js'
import { workspaceFor } from '../../identity/paths.js'
import { sweepAllTerminalTaskRuns } from '../../taskrun/store.js'

const DEFAULT_TTL_DAYS = 7
const DEFAULT_INTERVAL_MINUTES = 60
// `.lightclaw/exec/` holds RlaunchRuntime exec output-capture and file-staging
// scratch files. Each exec deletes its own files inline; this sweep only reaps
// stragglers left by a daemon crash mid-exec, so it runs on a much shorter TTL
// (6h) than the inbox/downloads artifact cache (7d).
const EXEC_SCRATCH_TTL_MS = 6 * 60 * 60 * 1000

export type InboxAgingConfig = {
  enabled: boolean
  ttlDays: number
  intervalMinutes: number
}

export const DEFAULT_INBOX_AGING_CONFIG: InboxAgingConfig = {
  enabled: true,
  ttlDays: DEFAULT_TTL_DAYS,
  intervalMinutes: DEFAULT_INTERVAL_MINUTES,
}

export type InboxAgingSweepResult = {
  user: string
  removedCount: number
  bytesFreed: number
  error?: string
}

let intervalHandle: NodeJS.Timeout | null = null

/** Walk one user's `<workspaceRoot>/<canonical>/.lightclaw/inbox/<chatId>/`,
 *  `<workspaceRoot>/<canonical>/.lightclaw/downloads/`, and
 *  `<workspaceRoot>/<canonical>/.lightclaw/skill-run/` dirs and delete files
 *  older than the configured TTL. Hermes-style mtime sweep — no archive, no
 *  soft-delete, no sidecar manifest. Empty subdirectories are left in place;
 *  cleaning empty dirs would race against in-flight writes.
 *
 *  inbox/ is two-deep (inbox/<chatId>/<file>) because attachments are scoped
 *  per chat. downloads/ is flat (downloads/<file>) because WebFetch has no
 *  natural namespace key. skill-run/ is recursive because skill scripts and
 *  references may have nested helper paths. All three share the same TTL since
 *  they are the same class of cache: agent-readable artifacts that decay in
 *  time. */
export async function sweepInboxForUser(input: {
  canonicalUser: string
  ttlDays: number
}): Promise<InboxAgingSweepResult> {
  const workspaceRoot = workspaceFor(input.canonicalUser)
  const cutoffMs = Date.now() - input.ttlDays * 86_400_000
  let removedCount = 0
  let bytesFreed = 0
  let firstError: string | undefined

  const inboxResult = await sweepNestedDir(
    path.join(workspaceRoot, '.lightclaw', 'inbox'),
    cutoffMs,
  )
  removedCount += inboxResult.removedCount
  bytesFreed += inboxResult.bytesFreed
  if (inboxResult.error && !firstError) firstError = inboxResult.error

  const downloadsResult = await sweepFlatDir(
    path.join(workspaceRoot, '.lightclaw', 'downloads'),
    cutoffMs,
  )
  removedCount += downloadsResult.removedCount
  bytesFreed += downloadsResult.bytesFreed
  if (downloadsResult.error && !firstError) firstError = downloadsResult.error

  const skillRunResult = await sweepRecursiveDir(
    path.join(workspaceRoot, '.lightclaw', 'skill-run'),
    cutoffMs,
  )
  removedCount += skillRunResult.removedCount
  bytesFreed += skillRunResult.bytesFreed
  if (skillRunResult.error && !firstError) firstError = skillRunResult.error

  // RlaunchRuntime exec scratch — its own short 6h TTL, independent of the
  // 7d artifact TTL above. Normal execs delete their files inline; this only
  // catches daemon-crash-mid-exec stragglers.
  const execResult = await sweepFlatDir(
    path.join(workspaceRoot, '.lightclaw', 'exec'),
    Date.now() - EXEC_SCRATCH_TTL_MS,
  )
  removedCount += execResult.removedCount
  bytesFreed += execResult.bytesFreed
  if (execResult.error && !firstError) firstError = execResult.error

  return {
    user: input.canonicalUser,
    removedCount,
    bytesFreed,
    error: firstError,
  }
}

type SweepDirResult = { removedCount: number; bytesFreed: number; error?: string }

async function sweepFlatDir(root: string, cutoffMs: number): Promise<SweepDirResult> {
  let files: string[]
  try {
    files = await fs.readdir(root)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { removedCount: 0, bytesFreed: 0 }
    return {
      removedCount: 0,
      bytesFreed: 0,
      error: error instanceof Error ? error.message : String(error),
    }
  }
  let removedCount = 0
  let bytesFreed = 0
  for (const file of files) {
    const filePath = path.join(root, file)
    let stat: Awaited<ReturnType<typeof fs.stat>>
    try {
      stat = await fs.stat(filePath)
    } catch {
      continue
    }
    if (!stat.isFile() || stat.mtimeMs >= cutoffMs) continue
    try {
      await fs.unlink(filePath)
      removedCount += 1
      bytesFreed += stat.size
    } catch {
      // Concurrent removal or permission error — skip silently. Aging is
      // best-effort; a stuck file is not worth surfacing every hour.
    }
  }
  return { removedCount, bytesFreed }
}

async function sweepRecursiveDir(root: string, cutoffMs: number): Promise<SweepDirResult> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { removedCount: 0, bytesFreed: 0 }
    return {
      removedCount: 0,
      bytesFreed: 0,
      error: error instanceof Error ? error.message : String(error),
    }
  }

  let removedCount = 0
  let bytesFreed = 0
  let firstError: string | undefined
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const sub = await sweepRecursiveDir(entryPath, cutoffMs)
      removedCount += sub.removedCount
      bytesFreed += sub.bytesFreed
      if (sub.error && !firstError) firstError = sub.error
      continue
    }
    if (!entry.isFile()) continue

    let stat: Awaited<ReturnType<typeof fs.stat>>
    try {
      stat = await fs.stat(entryPath)
    } catch {
      continue
    }
    if (stat.mtimeMs >= cutoffMs) continue
    try {
      await fs.unlink(entryPath)
      removedCount += 1
      bytesFreed += stat.size
    } catch {
      // Best-effort, symmetric with flat/nested sweeps above.
    }
  }

  return { removedCount, bytesFreed, error: firstError }
}

async function sweepNestedDir(root: string, cutoffMs: number): Promise<SweepDirResult> {
  let chatDirs: string[]
  try {
    chatDirs = await fs.readdir(root)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { removedCount: 0, bytesFreed: 0 }
    return {
      removedCount: 0,
      bytesFreed: 0,
      error: error instanceof Error ? error.message : String(error),
    }
  }
  let removedCount = 0
  let bytesFreed = 0
  for (const chatDir of chatDirs) {
    const sub = await sweepFlatDir(path.join(root, chatDir), cutoffMs)
    removedCount += sub.removedCount
    bytesFreed += sub.bytesFreed
  }
  return { removedCount, bytesFreed }
}

export async function runInboxAgingSweepOnce(
  config: InboxAgingConfig,
): Promise<InboxAgingSweepResult[]> {
  if (!config.enabled) return []
  let users: string[]
  try {
    users = await listActiveCanonicalUsers()
  } catch (error) {
    process.stderr.write(
      `[inbox-aging] failed to list users: ${error instanceof Error ? error.message : String(error)}\n`,
    )
    return []
  }
  if (users.length === 0) return []

  const settled = await Promise.allSettled(
    users.map(user => sweepInboxForUser({ canonicalUser: user, ttlDays: config.ttlDays })),
  )
  const results: InboxAgingSweepResult[] = []
  for (const [index, item] of settled.entries()) {
    if (item.status === 'fulfilled') {
      results.push(item.value)
    } else {
      results.push({
        user: users[index]!,
        removedCount: 0,
        bytesFreed: 0,
        error: item.reason instanceof Error ? item.reason.message : String(item.reason),
      })
    }
  }
  let totalRemoved = 0
  let totalBytes = 0
  for (const r of results) {
    totalRemoved += r.removedCount
    totalBytes += r.bytesFreed
    if (r.error) {
      process.stderr.write(`[inbox-aging] ${r.user}: ${r.error}\n`)
    }
  }
  // Always emit a heartbeat — without it, an operator grepping logs cannot
  // tell whether the hourly sweep is alive (silent) from "sweep ran, 0 to
  // reap" (silent). One stderr line per `intervalMinutes` is negligible vs
  // the dogfood loss when the scheduler is wedged.
  process.stderr.write(
    totalRemoved > 0
      ? `[inbox-aging] swept ${users.length} user(s), removed ${totalRemoved} file(s) (${formatBytes(totalBytes)})\n`
      : `[inbox-aging] swept ${users.length} user(s), 0 removed\n`,
  )

  // Piggyback durable TaskRun retention on the same per-user interval. Terminal
  // run dirs older than the inbox TTL are reaped; crashed (non-terminal) runs
  // are preserved for later reconciliation. Best-effort — a sweep failure must
  // never disturb the inbox aging result.
  try {
    const { removed } = await sweepAllTerminalTaskRuns({
      ttlMs: config.ttlDays * 24 * 60 * 60 * 1000,
    })
    if (removed > 0) {
      process.stderr.write(`[taskrun] retention swept ${removed} terminal run(s)\n`)
    }
  } catch (error) {
    process.stderr.write(
      `[taskrun] retention sweep failed: ${error instanceof Error ? error.message : String(error)}\n`,
    )
  }

  return results
}

export function startInboxAgingScheduler(config: InboxAgingConfig): void {
  if (!config.enabled) {
    process.stderr.write(`[inbox-aging] disabled\n`)
    return
  }
  if (intervalHandle !== null) return
  process.stderr.write(
    `[inbox-aging] scheduler started — ttl=${config.ttlDays}d interval=${config.intervalMinutes}m\n`,
  )
  // Fire once on startup, then on the configured cadence.
  void runInboxAgingSweepOnce(config).catch(error => {
    process.stderr.write(
      `[inbox-aging] startup sweep error: ${error instanceof Error ? error.message : String(error)}\n`,
    )
  })
  intervalHandle = setInterval(() => {
    void runInboxAgingSweepOnce(config).catch(error => {
      process.stderr.write(
        `[inbox-aging] sweep error: ${error instanceof Error ? error.message : String(error)}\n`,
      )
    })
  }, config.intervalMinutes * 60_000)
  intervalHandle.unref?.()
}

export function stopInboxAgingScheduler(): void {
  if (intervalHandle !== null) {
    clearInterval(intervalHandle)
    intervalHandle = null
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`
}
