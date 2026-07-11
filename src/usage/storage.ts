import fs from 'node:fs'
import path from 'node:path'

import { lightclawHome } from '../paths.js'
import type { ApiLogKind } from '../api-logs/storage.js'

// Usage kinds mirror the api-log call kinds so the two surfaces stay
// cross-checkable (api-logs success rows vs usage.jsonl rows), plus 'fresh'
// for ephemeral main-loop invocations. Sub-LLM kinds (session-memory /
// compact / web-fetch-summarize) are recorded since 2026-07-11; earlier
// files only contain main / fresh / subagent.
export type UsageKind = ApiLogKind | 'fresh'

export interface UsageRecord {
  ts: string  // ISO 8601
  user: string  // canonical user; '__terminal__' if no identity bound
  model: string
  kind: UsageKind
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
}

function usagePath(): string {
  return path.join(lightclawHome(), 'usage.jsonl')
}

/**
 * Append a usage record to <lightclawHome>/usage.jsonl.
 *
 * Uses fs.appendFile; per-record size is ~150 bytes which is well under
 * POSIX PIPE_BUF=4 KB, so concurrent writes from multiple users are atomic
 * at the line level. No locking required.
 *
 * Errors are caught and logged to stderr; usage telemetry must never block
 * or fail the main query path.
 */
export async function appendUsage(record: UsageRecord): Promise<void> {
  try {
    await fs.promises.mkdir(path.dirname(usagePath()), { recursive: true })
    await fs.promises.appendFile(usagePath(), JSON.stringify(record) + '\n', 'utf8')
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    process.stderr.write(`[usage] append failed: ${detail}\n`)
  }
}

/**
 * Stream all usage records, optionally filtered by ts >= sinceTs.
 *
 * Skips malformed lines silently — a single corrupt record must not break
 * the whole reader. Returns empty iterator when the file does not exist.
 */
export async function* readUsage(
  filter: { sinceTs?: string } = {},
): AsyncIterable<UsageRecord> {
  let raw: string
  try {
    raw = await fs.promises.readFile(usagePath(), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return
    }
    throw error
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let rec: UsageRecord
    try {
      rec = JSON.parse(line) as UsageRecord
    } catch {
      continue
    }
    if (filter.sinceTs && rec.ts < filter.sinceTs) continue
    yield rec
  }
}
