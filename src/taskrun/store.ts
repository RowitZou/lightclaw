import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { readdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'

import { safeWriteJson } from '../atomic-write.js'
import { sanitizePathSegment } from '../identity/paths.js'
import { getCurrentSessionContext } from '../session-context.js'
import { lightclawHome } from '../paths.js'
import type {
  TaskRunEvent,
  TaskRunFinishedEvent,
  TaskRunMeta,
  TaskRunMode,
  TaskRunOutcome,
  TaskRunStartedEvent,
} from './types.js'

const DEFAULT_TASKRUN_TTL_MS = 7 * 24 * 60 * 60 * 1000

type CreateTaskRunInput = {
  id?: string
  ownerCanonicalUser: string
  role: string
  callerRole: string
  callerSessionId: string
  mode: TaskRunMode
  objective: string
  title?: string
  parentRunId?: string | null
  chainId: string
  depth: number
  now?: number
}

type ListTaskRunsOptions = {
  scope?: 'mine' | 'all'
  sessionId?: string
}

type SweepTaskRunsOptions = {
  ttlMs?: number
  now?: number
}

const runLocks = new Map<string, Promise<void>>()

function taskRunsRoot(ownerCanonicalUser: string): string {
  return path.join(
    lightclawHome(),
    'identity',
    'per-user',
    sanitizePathSegment(ownerCanonicalUser),
    'taskruns',
  )
}

function taskRunDir(ownerCanonicalUser: string, id: string): string {
  return path.join(taskRunsRoot(ownerCanonicalUser), sanitizePathSegment(id))
}

function metaPath(ownerCanonicalUser: string, id: string): string {
  return path.join(taskRunDir(ownerCanonicalUser, id), 'meta.json')
}

function eventsPath(ownerCanonicalUser: string, id: string): string {
  return path.join(taskRunDir(ownerCanonicalUser, id), 'events.jsonl')
}

function createRunId(): string {
  return `tr_${randomUUID().replace(/-/g, '').slice(0, 20)}`
}

function titleFromObjective(objective: string): string {
  const firstLine = objective.split('\n').map(line => line.trim()).find(Boolean)
  return (firstLine ?? 'Untitled task').slice(0, 120)
}

async function withRunLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prior = runLocks.get(id) ?? Promise.resolve()
  let release!: () => void
  const next = new Promise<void>(resolve => {
    release = resolve
  })
  const chained = prior.then(() => next, () => next)
  runLocks.set(id, chained)
  await prior.catch(() => {})
  try {
    return await fn()
  } finally {
    release()
    if (runLocks.get(id) === chained) {
      runLocks.delete(id)
    }
  }
}

async function loadMetaFile(ownerCanonicalUser: string, id: string): Promise<TaskRunMeta | null> {
  try {
    const raw = await readFile(metaPath(ownerCanonicalUser, id), 'utf8')
    return JSON.parse(raw) as TaskRunMeta
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
}

async function appendRawEvents(
  ownerCanonicalUser: string,
  id: string,
  events: TaskRunEvent[],
): Promise<void> {
  if (events.length === 0) return
  mkdirSync(taskRunDir(ownerCanonicalUser, id), { recursive: true, mode: 0o700 })
  appendFileSync(
    eventsPath(ownerCanonicalUser, id),
    events.map(event => `${JSON.stringify(event)}\n`).join(''),
    'utf8',
  )
}

function writeMeta(meta: TaskRunMeta): void {
  safeWriteJson(metaPath(meta.ownerCanonicalUser, meta.id), meta, { mode: 0o600 })
}

export async function createTaskRun(input: CreateTaskRunInput): Promise<TaskRunMeta> {
  const id = input.id ?? createRunId()
  const now = input.now ?? Date.now()
  const parent = input.parentRunId
    ? await getTaskRun(input.parentRunId, input.ownerCanonicalUser)
    : null
  const parentRunId = input.parentRunId ?? null
  const rootRunId = parent?.rootRunId ?? parentRunId ?? id
  const meta: TaskRunMeta = {
    id,
    parentRunId,
    rootRunId,
    chainId: input.chainId,
    depth: input.depth,
    ownerCanonicalUser: input.ownerCanonicalUser,
    role: input.role,
    callerRole: input.callerRole,
    callerSessionId: input.callerSessionId,
    title: input.title?.trim() || titleFromObjective(input.objective),
    mode: input.mode,
    status: 'queued',
    currentSessionId: null,
    createdAt: now,
    updatedAt: now,
    lastEventSeq: 0,
  }
  const created: TaskRunEvent = {
    seq: 0,
    ts: now,
    kind: 'created',
    objective: input.objective,
    role: input.role,
    callerRole: input.callerRole,
    mode: input.mode,
    parentRunId,
    chainId: input.chainId,
  }
  await withRunLock(id, async () => {
    await appendRawEvents(input.ownerCanonicalUser, id, [created])
    writeMeta(meta)
  })
  return meta
}

export async function appendEvent(
  id: string,
  kind: string,
  payload: Record<string, unknown>,
  now = Date.now(),
  ownerCanonicalUser?: string,
): Promise<TaskRunMeta | null> {
  return withRunLock(id, async () => {
    const meta = await getTaskRun(id, ownerCanonicalUser)
    if (!meta) return null
    const event = {
      seq: meta.lastEventSeq + 1,
      ts: now,
      kind,
      ...payload,
    } as TaskRunEvent
    await appendRawEvents(meta.ownerCanonicalUser, id, [event])
    const next = reduceMeta(meta, event)
    writeMeta(next)
    return next
  })
}

export async function markStarted(
  id: string,
  sessionId: string,
  now = Date.now(),
  ownerCanonicalUser?: string,
): Promise<TaskRunMeta | null> {
  return appendEvent(id, 'started', { sessionId }, now, ownerCanonicalUser)
}

export async function markFinished(
  id: string,
  outcome: TaskRunOutcome,
  now = Date.now(),
  ownerCanonicalUser?: string,
): Promise<TaskRunMeta | null> {
  return appendEvent(id, 'finished', outcome, now, ownerCanonicalUser)
}

function reduceMeta(meta: TaskRunMeta, event: TaskRunEvent): TaskRunMeta {
  const next: TaskRunMeta = {
    ...meta,
    updatedAt: event.ts,
    lastEventSeq: event.seq,
  }
  if (isStartedEvent(event)) {
    return {
      ...next,
      status: 'running',
      currentSessionId: event.sessionId,
      startedAt: next.startedAt ?? event.ts,
    }
  }
  if (isFinishedEvent(event)) {
    return {
      ...next,
      status: event.ok ? 'done' : 'failed',
      currentSessionId: null,
      terminalAt: event.ts,
      outcome: {
        ok: event.ok,
        ...(event.summary ? { summary: event.summary } : {}),
        ...(event.error ? { error: event.error } : {}),
      },
    }
  }
  return next
}

function isStartedEvent(event: TaskRunEvent): event is TaskRunStartedEvent {
  return event.kind === 'started' && typeof (event as { sessionId?: unknown }).sessionId === 'string'
}

function isFinishedEvent(event: TaskRunEvent): event is TaskRunFinishedEvent {
  return event.kind === 'finished' && typeof (event as { ok?: unknown }).ok === 'boolean'
}

export async function getTaskRun(
  id: string,
  ownerCanonicalUser?: string,
): Promise<TaskRunMeta | null> {
  if (ownerCanonicalUser) {
    return loadMetaFile(ownerCanonicalUser, id)
  }
  const usersRoot = path.join(lightclawHome(), 'identity', 'per-user')
  let users
  try {
    users = await readdir(usersRoot, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  for (const user of users) {
    if (!user.isDirectory()) continue
    const meta = await loadMetaFile(user.name, id)
    if (meta) return meta
  }
  return null
}

export async function listTaskRuns(
  ownerCanonicalUser: string,
  options: ListTaskRunsOptions = {},
): Promise<TaskRunMeta[]> {
  let entries
  try {
    entries = await readdir(taskRunsRoot(ownerCanonicalUser), { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const sessionId = options.sessionId ?? getCurrentSessionContext()?.sessionId
  const metas: TaskRunMeta[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const meta = await loadMetaFile(ownerCanonicalUser, entry.name)
    if (!meta) continue
    if (
      options.scope !== 'all'
      && sessionId
      && meta.callerSessionId !== sessionId
      && meta.currentSessionId !== sessionId
    ) {
      continue
    }
    metas.push(meta)
  }
  metas.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
  return metas
}

export async function sweepTerminalTaskRuns(
  ownerCanonicalUser: string,
  options: SweepTaskRunsOptions = {},
): Promise<{ removed: number }> {
  const ttlMs = options.ttlMs ?? DEFAULT_TASKRUN_TTL_MS
  const now = options.now ?? Date.now()
  const runs = await listTaskRuns(ownerCanonicalUser, { scope: 'all' })
  let removed = 0
  await Promise.all(runs.map(async run => {
    if (run.terminalAt === undefined) return
    if (now - run.terminalAt <= ttlMs) return
    await rm(taskRunDir(ownerCanonicalUser, run.id), { recursive: true, force: true })
    removed += 1
  }))
  return { removed }
}

// Enumerate every per-user identity dir and sweep its terminal task runs. This
// is the retention entry point the per-user maintenance lane (inbox-aging) calls
// on its interval; non-terminal (crashed) runs are always preserved by the
// per-user sweep so a later watchdog can still reconcile them. Best-effort per
// user — one user's unreadable taskruns dir never aborts the rest.
export async function sweepAllTerminalTaskRuns(
  options: SweepTaskRunsOptions = {},
): Promise<{ removed: number }> {
  const usersRoot = path.join(lightclawHome(), 'identity', 'per-user')
  let users
  try {
    users = await readdir(usersRoot, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { removed: 0 }
    throw error
  }
  let removed = 0
  await Promise.all(users.map(async user => {
    if (!user.isDirectory()) return
    try {
      const result = await sweepTerminalTaskRuns(user.name, options)
      removed += result.removed
    } catch (error) {
      process.stderr.write(
        `[taskrun] retention sweep failed for ${user.name}: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      )
    }
  }))
  return { removed }
}
