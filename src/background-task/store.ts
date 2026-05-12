import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

import { identityRoot, sanitizePathSegment } from '../identity/paths.js'
import {
  backgroundTaskEntrySchema,
  type BackgroundTaskEntry,
  type BackgroundTaskStoreFile,
  type FireHistoryEntry,
} from './types.js'

const STORE_VERSION = 2
const FIRE_HISTORY_LIMIT = 20

type LastFiredDirty = {
  canonicalUser: string
  taskId: string
  when: string
}

const lastFiredDirty = new Map<string, LastFiredDirty>()
let lastFiredFlushTimer: NodeJS.Timeout | null = null

export function backgroundTaskStorePath(canonicalUser: string): string {
  return path.join(
    identityRoot(),
    'per-user',
    sanitizePathSegment(canonicalUser),
    'bg-tasks.json',
  )
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
      const candidateWithMigration =
        raw.version === 1
          ? { ...(candidate as object), allowedTools: undefined }
          : candidate
      const result = backgroundTaskEntrySchema.safeParse(candidateWithMigration)
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
    | 'consecutiveFailures'
    | 'fireHistory'
    | 'allowedTools'
    | 'pendingPriorPromptNotice'
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

export function appendFireHistory(input: {
  canonicalUser: string
  taskId: string
  entry: FireHistoryEntry
}): BackgroundTaskEntry | null {
  const task = getBackgroundTask(input.canonicalUser, input.taskId)
  if (!task) {
    return null
  }
  const history = [...(task.fireHistory ?? []), input.entry].slice(-FIRE_HISTORY_LIMIT)
  return updateBackgroundTask(input.canonicalUser, input.taskId, { fireHistory: history })
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

export function listAllUsersWithBackgroundTasks(): Array<{
  canonicalUser: string
  tasks: BackgroundTaskEntry[]
}> {
  const perUserRoot = path.join(identityRoot(), 'per-user')
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
