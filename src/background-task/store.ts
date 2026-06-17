import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

import {
  userBackgroundTasksPath,
  userCompletedBackgroundTasksPath,
  usersRoot,
} from '../identity/paths.js'
import {
  backgroundTaskEntrySchema,
  type BackgroundTaskEntry,
  type BackgroundTaskStoreFile,
} from './types.js'

const STORE_VERSION = 2

type LastFiredDirty = {
  canonicalUser: string
  taskId: string
  when: string
}

const lastFiredDirty = new Map<string, LastFiredDirty>()
let lastFiredFlushTimer: NodeJS.Timeout | null = null

export function backgroundTaskStorePath(canonicalUser: string): string {
  return userBackgroundTasksPath(canonicalUser)
}

export function loadBackgroundTasks(canonicalUser: string): BackgroundTaskEntry[] {
  const target = backgroundTaskStorePath(canonicalUser)
  if (!existsSync(target)) {
    return []
  }

  try {
    const parsed = JSON.parse(readFileSync(target, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object') {
      return []
    }
    const raw = parsed as Partial<BackgroundTaskStoreFile>
    if ((raw.version !== 1 && raw.version !== 2) || !Array.isArray(raw.tasks)) {
      return []
    }
    const tasks: BackgroundTaskEntry[] = []
    for (const candidate of raw.tasks) {
      const baseCandidate =
        raw.version === 1
          ? { ...(candidate as object), allowedTools: undefined }
          : { ...(candidate as object) }
      // Phase 8 PR5: backfill role for entries persisted before the field
      // existed. 'generalist' matches the legacy displayed default.
      if (typeof (baseCandidate as { role?: unknown }).role !== 'string') {
        ;(baseCandidate as { role: string }).role = 'generalist'
      }
      delete (baseCandidate as { consecutiveFailures?: unknown }).consecutiveFailures // legacy migration
      delete (baseCandidate as { fireHistory?: unknown }).fireHistory // legacy migration
      // Legacy field removed with dispatch context-inheritance retirement.
      delete (baseCandidate as Record<string, unknown>)['resume' + 'From']
      const result = backgroundTaskEntrySchema.safeParse(baseCandidate)
      if (result.success) {
        tasks.push(result.data)
      }
    }
    return tasks
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    process.stderr.write(`[background-task] failed to load ${target}: ${detail}\n`)
    return []
  }
}

export function saveBackgroundTasks(
  canonicalUser: string,
  tasks: BackgroundTaskEntry[],
): void {
  const target = backgroundTaskStorePath(canonicalUser)
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  const payload: BackgroundTaskStoreFile = {
    version: STORE_VERSION,
    tasks,
  }
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, target)
}

export function addBackgroundTask(
  canonicalUser: string,
  entry: BackgroundTaskEntry,
): void {
  const tasks = loadBackgroundTasks(canonicalUser)
  saveBackgroundTasks(canonicalUser, [...tasks.filter(task => task.id !== entry.id), entry])
}

export function removeBackgroundTask(canonicalUser: string, id: string): boolean {
  const tasks = loadBackgroundTasks(canonicalUser)
  const next = tasks.filter(task => task.id !== id)
  if (next.length === tasks.length) {
    return false
  }
  saveBackgroundTasks(canonicalUser, next)
  return true
}

export type BackgroundTaskPatch = Partial<
  Pick<
    BackgroundTaskEntry,
    | 'prompt'
    | 'schedule'
    | 'label'
    | 'notifyOn'
    | 'notifyTo'
    | 'enabled'
    | 'lastFiredAt'
    | 'pendingPriorPromptNotice'
    | 'parentTaskRunId'
    | 'standingRootRunId'
    | 'taskRunId'
  >
>

export function updateBackgroundTask(
  canonicalUser: string,
  id: string,
  patch: BackgroundTaskPatch,
): BackgroundTaskEntry | null {
  const tasks = loadBackgroundTasks(canonicalUser)
  let updated: BackgroundTaskEntry | null = null
  const next = tasks.map(task => {
    if (task.id !== id) {
      return task
    }
    updated = { ...task, ...patch }
    return updated
  })
  if (!updated) {
    return null
  }
  saveBackgroundTasks(canonicalUser, next)
  return updated
}

export function getBackgroundTask(
  canonicalUser: string,
  id: string,
): BackgroundTaskEntry | null {
  return loadBackgroundTasks(canonicalUser).find(task => task.id === id) ?? null
}

export function updateLastFiredAt(
  canonicalUser: string,
  taskId: string,
  when: string,
): void {
  const key = `${canonicalUser}:${taskId}`
  lastFiredDirty.set(key, { canonicalUser, taskId, when })
  if (!lastFiredFlushTimer) {
    lastFiredFlushTimer = setTimeout(() => {
      flushLastFiredAt()
    }, 5000)
    lastFiredFlushTimer.unref?.()
  }
}

export function flushLastFiredAt(): void {
  if (lastFiredFlushTimer) {
    clearTimeout(lastFiredFlushTimer)
    lastFiredFlushTimer = null
  }
  const pending = [...lastFiredDirty.values()]
  lastFiredDirty.clear()
  for (const item of pending) {
    updateBackgroundTask(item.canonicalUser, item.taskId, {
      lastFiredAt: item.when,
    })
  }
}

// Completed-task index: append-only JSONL beside bg-tasks.json. Lets
// TaskUpdate cancel / UpdateSchedule distinguish "task is gone because it already finished"
// from "id never existed" so cancel can be idempotent (HTTP DELETE-style).
// Successful oneshot tasks are pruned from bg-tasks.json on completion; without
// this index the model sees `is_error: true` on a no-op cancel and starts an
// unnecessary recovery flow.

const COMPLETED_INDEX_VERSION = 1

export type CompletedTaskOutcome = 'success' | 'failure' | 'cancelled' | 'aborted'

export interface CompletedTaskRecord {
  version: typeof COMPLETED_INDEX_VERSION
  id: string
  outcome: CompletedTaskOutcome
  completedAt: string
  summary?: string
}

export function completedTaskIndexPath(canonicalUser: string): string {
  return userCompletedBackgroundTasksPath(canonicalUser)
}

export function appendCompletedTaskRecord(
  canonicalUser: string,
  entry: Omit<CompletedTaskRecord, 'version'>,
): void {
  const target = completedTaskIndexPath(canonicalUser)
  try {
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
    const line = JSON.stringify({ version: COMPLETED_INDEX_VERSION, ...entry })
    appendFileSync(target, `${line}\n`, { mode: 0o600 })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    process.stderr.write(
      `[background-task] failed to append completed-task record to ${target}: ${detail}\n`,
    )
  }
}

// Latest-wins: an id that appears once on success and again on a later
// cancel attempt is reported as the most recent record. The file is small
// (one short line per oneshot completion / cancel) so a linear scan is fine.
export function getCompletedTaskRecord(
  canonicalUser: string,
  id: string,
): CompletedTaskRecord | null {
  const target = completedTaskIndexPath(canonicalUser)
  if (!existsSync(target)) {
    return null
  }
  let raw: string
  try {
    raw = readFileSync(target, 'utf8')
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    process.stderr.write(
      `[background-task] failed to read completed-task index ${target}: ${detail}\n`,
    )
    return null
  }
  let latest: CompletedTaskRecord | null = null
  for (const line of raw.split('\n')) {
    if (!line.trim()) {
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (
      !parsed
      || typeof parsed !== 'object'
      || (parsed as { id?: unknown }).id !== id
    ) {
      continue
    }
    const candidate = parsed as Partial<CompletedTaskRecord>
    if (
      candidate.version !== COMPLETED_INDEX_VERSION
      || typeof candidate.outcome !== 'string'
      || typeof candidate.completedAt !== 'string'
      || typeof candidate.id !== 'string'
    ) {
      continue
    }
    if (
      candidate.outcome !== 'success'
      && candidate.outcome !== 'failure'
      && candidate.outcome !== 'cancelled'
      && candidate.outcome !== 'aborted'
    ) {
      continue
    }
    latest = {
      version: COMPLETED_INDEX_VERSION,
      id: candidate.id,
      outcome: candidate.outcome,
      completedAt: candidate.completedAt,
      ...(typeof candidate.summary === 'string' ? { summary: candidate.summary } : {}),
    }
  }
  return latest
}

export function listAllUsersWithBackgroundTasks(): Array<{
  canonicalUser: string
  tasks: BackgroundTaskEntry[]
}> {
  const perUserRoot = usersRoot()
  if (!existsSync(perUserRoot)) {
    return []
  }

  const out: Array<{ canonicalUser: string; tasks: BackgroundTaskEntry[] }> = []
  for (const entry of readdirSync(perUserRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue
    }
    const tasks = loadBackgroundTasks(entry.name)
    if (tasks.length > 0) {
      out.push({ canonicalUser: entry.name, tasks })
    }
  }
  return out
}
