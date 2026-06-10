import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { readdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'

import { safeWriteJson } from '../atomic-write.js'
import { loadBackgroundTasks } from '../background-task/store.js'
import { sanitizePathSegment } from '../identity/paths.js'
import { getCurrentSessionContext } from '../session-context.js'
import { lightclawHome } from '../paths.js'
import type {
  TaskRunArtifactEvent,
  TaskRunCancelledEvent,
  TaskRunDeliveredEvent,
  TaskRunEvent,
  TaskRunFinishedEvent,
  TaskRunKind,
  TaskRunMeta,
  TaskRunMode,
  TaskRunOutcome,
  TaskRunPausedEvent,
  TaskRunProgressEvent,
  TaskRunStartedEvent,
} from './types.js'

const DEFAULT_TASKRUN_TTL_MS = 7 * 24 * 60 * 60 * 1000

type CreateTaskRunInput = {
  id?: string
  kind?: TaskRunKind
  standing?: boolean
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

type GetTaskRunEventsOptions = {
  limit?: number
}

type CreateRootTaskRunInput = {
  objective: string
  title?: string
  now?: number
}

type CreateStandingRootTaskRunInput = {
  objective: string
  title?: string
  role: string
  callerRole: string
  callerSessionId: string
  chainId: string
  now?: number
}

export type RootObligations = {
  openRuns: TaskRunMeta[]
  openRunIds: string[]
  pendingDispatchIds: string[]
}

export type CloseRootResult =
  | { closed: true; meta: TaskRunMeta }
  | { closed: false; reason: 'not-found' | 'not-root' | 'already-terminal' }
  | { closed: false; reason: 'open-obligations'; obligations: RootObligations }

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

export async function listTaskRunOwners(): Promise<string[]> {
  const usersRoot = path.join(lightclawHome(), 'identity', 'per-user')
  let users
  try {
    users = await readdir(usersRoot, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const owners: string[] = []
  for (const user of users) {
    if (!user.isDirectory()) continue
    try {
      const taskruns = await readdir(path.join(usersRoot, user.name, 'taskruns'), {
        withFileTypes: true,
      })
      if (taskruns.some(entry => entry.isDirectory())) {
        owners.push(user.name)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
  }
  return owners.sort()
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

function isTerminalStatus(status: TaskRunMeta['status']): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled'
}

function taskRunKind(meta: TaskRunMeta): TaskRunKind {
  return meta.kind ?? 'dispatch'
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
    kind: input.kind ?? 'dispatch',
    ...(input.standing ? { standing: true } : {}),
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
    taskRunKind: input.kind ?? 'dispatch',
    ...(input.standing ? { standing: true } : {}),
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

export async function createRootTaskRun(
  ownerCanonicalUser: string,
  mainSessionId: string,
  input: CreateRootTaskRunInput,
): Promise<TaskRunMeta> {
  const run = await createTaskRun({
    ownerCanonicalUser,
    kind: 'root',
    role: 'main',
    callerRole: 'main',
    callerSessionId: mainSessionId,
    mode: 'blocking',
    objective: input.objective,
    title: input.title,
    parentRunId: null,
    chainId: mainSessionId,
    depth: 0,
    now: input.now,
  })
  return await markStarted(
    run.id,
    mainSessionId,
    input.now ?? Date.now(),
    ownerCanonicalUser,
  ) ?? run
}

export async function createStandingRootTaskRun(
  ownerCanonicalUser: string,
  input: CreateStandingRootTaskRunInput,
): Promise<TaskRunMeta> {
  const run = await createTaskRun({
    ownerCanonicalUser,
    kind: 'root',
    standing: true,
    role: input.role,
    callerRole: input.callerRole,
    callerSessionId: input.callerSessionId,
    mode: 'background',
    objective: input.objective,
    title: input.title,
    parentRunId: null,
    chainId: input.chainId,
    depth: 0,
    now: input.now,
  })
  return await markStarted(
    run.id,
    input.callerSessionId,
    input.now ?? Date.now(),
    ownerCanonicalUser,
  ) ?? run
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

export async function markDelivered(
  id: string,
  outcome: TaskRunOutcome,
  now = Date.now(),
  ownerCanonicalUser?: string,
): Promise<TaskRunMeta | null> {
  // Idempotent: a worker may have explicitly delivered its own run (TaskUpdate)
  // before the framework's settle-on-return path fires — the first self-report
  // wins and is never overwritten by the framework's derived outcome.
  const meta = await getTaskRun(id, ownerCanonicalUser)
  if (!meta) return null
  if (meta.status === 'delivered' || isTerminalStatus(meta.status)) return meta
  if (meta.status === 'paused') return meta
  return appendEvent(
    id,
    'delivered',
    {
      ok: outcome.ok,
      ...(outcome.summary ? { summary: outcome.summary } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
    },
    now,
    ownerCanonicalUser,
  )
}

export async function markPaused(
  id: string,
  input: { reason: 'user-stop'; bySessionId: string },
  now = Date.now(),
  ownerCanonicalUser?: string,
): Promise<TaskRunMeta | null> {
  const meta = await getTaskRun(id, ownerCanonicalUser)
  if (!meta || meta.status === 'paused' || isTerminalStatus(meta.status)) return meta
  if (meta.status !== 'running' && meta.status !== 'blocked') return meta
  return appendEvent(
    id,
    'paused',
    { reason: input.reason, bySessionId: input.bySessionId },
    now,
    meta.ownerCanonicalUser,
  )
}

export async function acceptTaskRun(
  id: string,
  input: { byRole: string; auto?: boolean },
  now = Date.now(),
  ownerCanonicalUser?: string,
): Promise<TaskRunMeta | null> {
  const meta = await getTaskRun(id, ownerCanonicalUser)
  if (!meta || meta.status !== 'delivered') return null
  await appendEvent(
    id,
    'accepted',
    { byRole: input.byRole, ...(input.auto ? { auto: true } : {}) },
    now,
    meta.ownerCanonicalUser,
  )
  return markFinished(
    id,
    {
      ok: meta.outcome?.ok ?? true,
      ...(meta.outcome?.summary ? { summary: meta.outcome.summary } : {}),
      ...(meta.outcome?.error ? { error: meta.outcome.error } : {}),
    },
    now,
    meta.ownerCanonicalUser,
  )
}

export async function rejectTaskRun(
  id: string,
  input: { byRole: string; feedback: string },
  now = Date.now(),
  ownerCanonicalUser?: string,
): Promise<TaskRunMeta | null> {
  const meta = await getTaskRun(id, ownerCanonicalUser)
  if (!meta || meta.status !== 'delivered') return null
  await appendEvent(
    id,
    'rejected',
    { byRole: input.byRole, feedback: input.feedback },
    now,
    meta.ownerCanonicalUser,
  )
  // V1 stopgap: a rejected run closes as failed and the caller re-dispatches
  // with the feedback. "Keep the run open and resume its session" is the
  // collab-phase3 upgrade; the rejected event preserves the fact either way.
  return markFinished(
    id,
    { ok: false, error: `Rejected by ${input.byRole}: ${input.feedback}` },
    now,
    meta.ownerCanonicalUser,
  )
}

export async function markCancelled(
  id: string,
  reason?: string,
  now = Date.now(),
  ownerCanonicalUser?: string,
  options: { allowRunning?: boolean } = {},
): Promise<TaskRunMeta | null> {
  const meta = await getTaskRun(id, ownerCanonicalUser)
  if (!meta || isTerminalStatus(meta.status)) return meta
  const cancellable =
    meta.status === 'queued' ||
    meta.status === 'paused' ||
    (options.allowRunning === true && meta.status === 'running')
  if (!cancellable) return meta
  return appendEvent(id, 'cancelled', reason ? { reason } : {}, now, meta.ownerCanonicalUser)
}

export async function appendProgress(
  id: string,
  progress: { phase?: string; label: string },
  now = Date.now(),
  ownerCanonicalUser?: string,
): Promise<TaskRunMeta | null> {
  return appendEvent(
    id,
    'progress',
    {
      ...(progress.phase ? { phase: progress.phase } : {}),
      label: progress.label,
    },
    now,
    ownerCanonicalUser,
  )
}

export async function appendArtifact(
  id: string,
  artifact: { path?: string; token?: string; kind?: string; label?: string },
  now = Date.now(),
  ownerCanonicalUser?: string,
): Promise<TaskRunMeta | null> {
  return appendEvent(
    id,
    'artifact',
    {
      ...(artifact.path ? { path: artifact.path } : {}),
      ...(artifact.token ? { token: artifact.token } : {}),
      ...(artifact.kind ? { artifactKind: artifact.kind } : {}),
      ...(artifact.label ? { label: artifact.label } : {}),
    },
    now,
    ownerCanonicalUser,
  )
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
  if (isDeliveredEvent(event)) {
    return {
      ...next,
      status: 'delivered',
      currentSessionId: null,
      deliveredAt: event.ts,
      outcome: {
        ok: event.ok,
        ...(event.summary ? { summary: event.summary } : {}),
        ...(event.error ? { error: event.error } : {}),
      },
    }
  }
  if (isCancelledEvent(event)) {
    return {
      ...next,
      status: 'cancelled',
      currentSessionId: null,
      terminalAt: event.ts,
    }
  }
  if (isPausedEvent(event)) {
    return {
      ...next,
      status: 'paused',
      currentSessionId: null,
      pausedAt: event.ts,
      pauseReason: event.reason,
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
  if (isProgressEvent(event)) {
    return {
      ...next,
      latestProgress: {
        ...(event.phase ? { phase: event.phase } : {}),
        label: event.label,
        ts: event.ts,
      },
    }
  }
  if (isArtifactEvent(event)) {
    const handle = event.path ?? event.token
    if (!handle) return next
    const existing = next.artifactPaths ?? []
    return {
      ...next,
      artifactPaths: existing.includes(handle) ? existing : [...existing, handle],
    }
  }
  return next
}

function isStartedEvent(event: TaskRunEvent): event is TaskRunStartedEvent {
  return event.kind === 'started' && typeof (event as { sessionId?: unknown }).sessionId === 'string'
}

function isDeliveredEvent(event: TaskRunEvent): event is TaskRunDeliveredEvent {
  return event.kind === 'delivered' && typeof (event as { ok?: unknown }).ok === 'boolean'
}

function isCancelledEvent(event: TaskRunEvent): event is TaskRunCancelledEvent {
  return event.kind === 'cancelled'
}

function isPausedEvent(event: TaskRunEvent): event is TaskRunPausedEvent {
  return event.kind === 'paused' && (event as { reason?: unknown }).reason === 'user-stop'
}

function isFinishedEvent(event: TaskRunEvent): event is TaskRunFinishedEvent {
  return event.kind === 'finished' && typeof (event as { ok?: unknown }).ok === 'boolean'
}

function isProgressEvent(event: TaskRunEvent): event is TaskRunProgressEvent {
  return event.kind === 'progress' && typeof (event as { label?: unknown }).label === 'string'
}

function isArtifactEvent(event: TaskRunEvent): event is TaskRunArtifactEvent {
  return event.kind === 'artifact'
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

export async function getTaskRunEvents(
  id: string,
  options: GetTaskRunEventsOptions = {},
  ownerCanonicalUser?: string,
): Promise<TaskRunEvent[]> {
  const meta = await getTaskRun(id, ownerCanonicalUser)
  if (!meta) return []
  let raw: string
  try {
    raw = await readFile(eventsPath(meta.ownerCanonicalUser, id), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const events = raw
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as TaskRunEvent)
  const limit = options.limit
  if (limit === undefined || limit <= 0 || events.length <= limit) {
    return events
  }
  return events.slice(-limit)
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

export async function listChildTaskRuns(
  parentRunId: string,
  ownerCanonicalUser: string,
): Promise<TaskRunMeta[]> {
  const runs = await listTaskRuns(ownerCanonicalUser, { scope: 'all' })
  return runs
    .filter(run => run.parentRunId === parentRunId)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
}

export async function listOpenRootTaskRuns(
  ownerCanonicalUser: string,
  mainSessionId: string,
): Promise<TaskRunMeta[]> {
  const runs = await listTaskRuns(ownerCanonicalUser, { scope: 'all' })
  return runs
    .filter(run =>
      taskRunKind(run) === 'root' &&
      run.standing !== true &&
      run.callerSessionId === mainSessionId &&
      !isTerminalStatus(run.status),
    )
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
}

export async function getRootObligations(
  rootRunId: string,
  ownerCanonicalUser: string,
): Promise<RootObligations> {
  const root = await getTaskRun(rootRunId, ownerCanonicalUser)
  if (!root || taskRunKind(root) !== 'root') {
    return { openRuns: [], openRunIds: [], pendingDispatchIds: [] }
  }

  const runs = await listTaskRuns(ownerCanonicalUser, { scope: 'all' })
  const subtreeIds = new Set<string>([root.id])
  let changed = true
  while (changed) {
    changed = false
    for (const run of runs) {
      if (run.parentRunId && subtreeIds.has(run.parentRunId) && !subtreeIds.has(run.id)) {
        subtreeIds.add(run.id)
        changed = true
      }
    }
  }

  const openRuns = runs
    .filter(run =>
      run.id !== root.id &&
      subtreeIds.has(run.id) &&
      !isTerminalStatus(run.status),
    )
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  const openRunIds = openRuns.map(run => run.id)

  // Oneshot entries now create their queued run at dispatch time and are
  // covered by openRuns through it; this scan only backstops legacy entries
  // persisted before dispatch-time creation (no taskRunId on the entry).
  const pendingDispatchIds = loadBackgroundTasks(ownerCanonicalUser)
    .filter(task =>
      task.enabled &&
      task.schedule.kind === 'oneshot' &&
      task.taskRunId === undefined &&
      task.parentTaskRunId !== undefined &&
      subtreeIds.has(task.parentTaskRunId),
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .map(task => task.id)

  return { openRuns, openRunIds, pendingDispatchIds }
}

export async function closeRootTaskRun(
  rootRunId: string,
  ownerCanonicalUser: string,
  now = Date.now(),
): Promise<CloseRootResult> {
  const root = await getTaskRun(rootRunId, ownerCanonicalUser)
  if (!root) return { closed: false, reason: 'not-found' }
  if (taskRunKind(root) !== 'root') return { closed: false, reason: 'not-root' }
  if (isTerminalStatus(root.status)) return { closed: false, reason: 'already-terminal' }
  const obligations = await getRootObligations(rootRunId, ownerCanonicalUser)
  if (obligations.openRunIds.length > 0 || obligations.pendingDispatchIds.length > 0) {
    return { closed: false, reason: 'open-obligations', obligations }
  }
  const meta = await markFinished(
    root.id,
    { ok: true, summary: 'Delivered by main.' },
    now,
    ownerCanonicalUser,
  )
  return meta ? { closed: true, meta } : { closed: false, reason: 'not-found' }
}

export async function sweepTerminalTaskRuns(
  ownerCanonicalUser: string,
  options: SweepTaskRunsOptions = {},
): Promise<{ removed: number }> {
  const ttlMs = options.ttlMs ?? DEFAULT_TASKRUN_TTL_MS
  const now = options.now ?? Date.now()
  const runs = await listTaskRuns(ownerCanonicalUser, { scope: 'all' })
  // A tree with any non-terminal run must keep ALL its nodes: sweeping a
  // terminal mid-tree node breaks parentRunId reachability, so obligations /
  // TaskInspect would silently lose live descendants under an open root.
  const liveTreeRootIds = new Set(
    runs.filter(run => !isTerminalStatus(run.status)).map(run => run.rootRunId),
  )
  let removed = 0
  await Promise.all(runs.map(async run => {
    if (run.terminalAt === undefined) return
    if (now - run.terminalAt <= ttlMs) return
    if (liveTreeRootIds.has(run.rootRunId)) return
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
