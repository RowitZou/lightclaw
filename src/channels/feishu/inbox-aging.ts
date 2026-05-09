import { promises as fs } from 'node:fs'
import path from 'node:path'

import { listActiveCanonicalUsers } from '../../identity/store.js'
import { workspaceFor } from '../../identity/paths.js'

const DEFAULT_TTL_DAYS = 7
const DEFAULT_INTERVAL_MINUTES = 60

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

/** Walk one user's `<workspaceRoot>/<canonical>/.lightclaw/inbox/<chatId>/` dir
 *  and delete files older than the configured TTL. Hermes-style mtime sweep —
 *  no archive, no soft-delete, no sidecar manifest. Empty chat directories
 *  are left in place; cleaning empty dirs would race against in-flight
 *  attachment writes. */
export async function sweepInboxForUser(input: {
  canonicalUser: string
  ttlDays: number
}): Promise<InboxAgingSweepResult> {
  const workspaceRoot = workspaceFor(input.canonicalUser)
  const inboxRoot = path.join(workspaceRoot, '.lightclaw', 'inbox')
  const cutoffMs = Date.now() - input.ttlDays * 86_400_000
  let removedCount = 0
  let bytesFreed = 0

  let chatDirs: string[]
  try {
    chatDirs = await fs.readdir(inboxRoot)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      return { user: input.canonicalUser, removedCount, bytesFreed }
    }
    return {
      user: input.canonicalUser,
      removedCount,
      bytesFreed,
      error: error instanceof Error ? error.message : String(error),
    }
  }

  for (const chatDir of chatDirs) {
    const chatPath = path.join(inboxRoot, chatDir)
    let files: string[]
    try {
      files = await fs.readdir(chatPath)
    } catch {
      continue
    }
    for (const file of files) {
      const filePath = path.join(chatPath, file)
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
  }

  return { user: input.canonicalUser, removedCount, bytesFreed }
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
  if (totalRemoved > 0) {
    process.stderr.write(
      `[inbox-aging] removed ${totalRemoved} file(s) (${formatBytes(totalBytes)}) across ${users.length} user(s)\n`,
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
