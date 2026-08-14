import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { readdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'

import { safeWriteJson } from '../atomic-write.js'
import { loadBackgroundTasks } from '../background-task/store.js'
import { sanitizePathSegment, userTaskRunsRoot, usersRoot } from '../identity/paths.js'
import { getCurrentSessionContext } from '../session-context.js'
import type { ChainState } from '../signal-bus/chain-state.js'
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
  TaskRunWaitingEvent,
  TaskRunWaitReason,
  TaskRunProgressEvent,
  TaskRunRebuiltEvent,
  TaskRunResumedEvent,
  TaskRunStartedEvent,
  TaskRunUsageEvent,
  TaskRunUsageTotals,
  TaskRunWakeSpec,
} from './types.js'
import { clearReplyCodesForRun } from './reply-code-registry.js'

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
  interjectionSessionId?: string
  chainState?: ChainState
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
  // Restrict to these event kinds BEFORE `limit` is applied, so a tail read of
  // (e.g.) progress events is not diluted by interleaved high-frequency `usage`
  // events sharing the same stream.
  kinds?: string[]
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
  return userTaskRunsRoot(ownerCanonicalUser)
}

export async function listTaskRunOwners(): Promise<string[]> {
  let users
  try {
    users = await readdir(usersRoot(), { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const owners: string[] = []
  for (const user of users) {
    if (!user.isDirectory()) continue
    try {
      const taskruns = await readdir(userTaskRunsRoot(user.name), {
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

/** Directory of one TaskRun, for sidecar files that live beside the ledger
 *  (e.g. the Feishu task-card binding). The ledger files themselves
 *  (events.jsonl / meta.json) stay private to this module. */
export function taskRunDirPath(ownerCanonicalUser: string, id: string): string {
  return taskRunDir(ownerCanonicalUser, id)
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

function createReportCode(): string {
  return `rp_${randomUUID().replace(/-/g, '').slice(0, 8)}`
}

function titleFromObjective(objective: string): string {
  const firstLine = objective.split('\n').map(line => line.trim()).find(Boolean)
  return (firstLine ?? 'Untitled task').slice(0, 120)
}

/** The absorbing statuses: a run that reached one never runs again — no wake,
 *  resume, rebuild or late fire may take it back out. Single definition for
 *  every module that enforces that finality (store transitions, the watchdog's
 *  sweep/reconcile gates, the resume chokepoint). */
export function isTerminalTaskRunStatus(status: TaskRunMeta['status']): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled'
}

const isTerminalStatus = isTerminalTaskRunStatus

/** Whether `markDelivered` would actually transition a run at this status into
 *  `delivered` (vs. return it unchanged). True only for not-yet-concluded
 *  states; a run that already self-delivered, is terminal, or was set waiting
 *  (e.g. user-stop) is left as-is. Exported as the single source of truth so
 *  callers that need to know "did THIS path perform the delivery" — notably the
 *  scheduler's settle-on-return child-join wake — stay in lockstep with
 *  `markDelivered`'s own idempotency condition. */
export function markDeliveredWouldTransition(status: TaskRunMeta['status']): boolean {
  return status !== 'delivered' && status !== 'waiting' && !isTerminalStatus(status)
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
    return normalizeLegacyMeta(JSON.parse(raw) as TaskRunMeta)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
}

/** Meta files persisted before the wait rename carry status 'paused' and the
 *  pausedAt / pauseReason field spellings; normalize on read (the next write
 *  persists the new shape). */
function normalizeLegacyMeta(meta: TaskRunMeta): TaskRunMeta {
  const legacy = meta as TaskRunMeta & {
    pausedAt?: number
    pauseReason?: string
  }
  const legacyStatus = legacy.status as string
  if (legacyStatus !== 'paused' && legacy.pausedAt === undefined && legacy.pauseReason === undefined) {
    return meta
  }
  const waitReason = (legacy.waitReason ?? legacy.pauseReason) as TaskRunMeta['waitReason']
  return {
    ...meta,
    status: legacyStatus === 'paused' ? 'waiting' : legacy.status,
    ...(legacy.waitingAt ?? legacy.pausedAt ? { waitingAt: legacy.waitingAt ?? legacy.pausedAt } : {}),
    ...(waitReason
      ? { waitReason: (waitReason as string) === 'requester-pause' ? 'requester-hold' : waitReason }
      : {}),
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

// In-process event tap. One daemon process owns a home (the same premise
// the memory per-dir rebuild lock rests on), so an in-memory listener set
// sees every ledger write. Listeners are observers only: they fire AFTER
// the event and meta are durably written, each call is isolated in its
// own try/catch, and a throwing listener can never fail or roll back the
// write path.
export type TaskRunEventListener = (
  ownerCanonicalUser: string,
  runId: string,
  event: TaskRunEvent,
  meta: TaskRunMeta,
) => void

const taskRunEventListeners = new Set<TaskRunEventListener>()

export function onTaskRunEvent(listener: TaskRunEventListener): () => void {
  taskRunEventListeners.add(listener)
  return () => {
    taskRunEventListeners.delete(listener)
  }
}

function notifyTaskRunEvent(
  ownerCanonicalUser: string,
  runId: string,
  event: TaskRunEvent,
  meta: TaskRunMeta,
): void {
  for (const listener of taskRunEventListeners) {
    try {
      listener(ownerCanonicalUser, runId, event, meta)
    } catch (error) {
      process.stderr.write(
        `[taskrun] event listener failed for ${runId}: ${(error as Error).message}\n`,
      )
    }
  }
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
    ...(input.interjectionSessionId ? { interjectionSessionId: input.interjectionSessionId } : {}),
    ...(input.chainState ? { chainState: input.chainState } : {}),
    // Only a run with a requester gets one. A root is main's own work order:
    // main talks to the user through the channel, not through an uplink.
    ...(parentRunId ? { reportCode: createReportCode() } : {}),
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
    ...(input.chainState ? { chainState: input.chainState } : {}),
  }
  await withRunLock(id, async () => {
    await appendRawEvents(input.ownerCanonicalUser, id, [created])
    writeMeta(meta)
  })
  notifyTaskRunEvent(input.ownerCanonicalUser, id, created, meta)
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
  const result = await withRunLock(id, async () => {
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
    // Reply-codes (parent→worker Message gating) live for the LIFE OF THE RUN,
    // not a single shift. A monitoring worker that resumes on timers receives a
    // code during the parent's Message turn and may not consume it until a later
    // resumed shift, several shift-ends away — clearing at every shift end (the
    // old resume.ts / dispatched-agent.ts finally) wiped the code before the
    // worker could reply (2026-06-17 dogfood: rc minted + delivered in a resume
    // block, the worker's Message reply got "none pending"). Clear only on the
    // run's terminal transition: bounded (live runs × a few codes), and the
    // in-memory registry dies with the process regardless.
    if (!isTerminalStatus(meta.status) && isTerminalStatus(next.status)) {
      clearReplyCodesForRun(id)
    }
    return { event, next }
  })
  if (!result) return null
  notifyTaskRunEvent(result.next.ownerCanonicalUser, id, result.event, result.next)
  return result.next
}

export async function markStarted(
  id: string,
  sessionId: string,
  now = Date.now(),
  ownerCanonicalUser?: string,
): Promise<TaskRunMeta | null> {
  // Terminal verdicts are final: a late fire path (e.g. a scheduler item whose
  // backing run was cancelled before fire time) must not flip the run back to
  // running via the unconditional started reducer.
  const meta = await getTaskRun(id, ownerCanonicalUser)
  if (!meta) return null
  if (isTerminalStatus(meta.status)) return meta
  const next = await appendEvent(id, 'started', { sessionId }, now, ownerCanonicalUser)
  if (next?.status === 'running') await reactivateUserStoppedAncestors(next, now)
  return next
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
  if (!markDeliveredWouldTransition(meta.status)) return meta
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

export async function markWaiting(
  id: string,
  input: { reason: TaskRunWaitReason; bySessionId?: string; wake?: TaskRunWakeSpec },
  now = Date.now(),
  ownerCanonicalUser?: string,
): Promise<TaskRunMeta | null> {
  const meta = await getTaskRun(id, ownerCanonicalUser)
  if (!meta || meta.status === 'waiting' || isTerminalStatus(meta.status)) return meta
  if (meta.status !== 'running' && meta.status !== 'blocked') return meta
  return appendEvent(
    id,
    'waiting',
    {
      reason: input.reason,
      ...(input.bySessionId ? { bySessionId: input.bySessionId } : {}),
      ...(input.wake ? { wake: input.wake } : {}),
    },
    now,
    meta.ownerCanonicalUser,
  )
}

export async function appendCheckpoint(
  id: string,
  checkpoint: string,
  now = Date.now(),
  ownerCanonicalUser?: string,
): Promise<TaskRunMeta | null> {
  return appendEvent(id, 'checkpoint', { checkpoint }, now, ownerCanonicalUser)
}

export async function markResumed(
  id: string,
  input: { via: TaskRunResumedEvent['via']; sessionId: string; reason?: string },
  now = Date.now(),
  ownerCanonicalUser?: string,
): Promise<TaskRunMeta | null> {
  // Same finality markStarted enforces, for the revival edge one level over: a
  // wake that was armed while the run was alive and lands after it settled
  // (an in-process timer whose resume queued behind a long shift, a watchdog
  // due-wake scheduled a tick before the verdict) must not flip a terminal run
  // back to running. 2026-08-14 prod: an accepted run resumed 3 minutes after
  // its `finished` event and kept working as a zombie beside its successor.
  const meta = await getTaskRun(id, ownerCanonicalUser)
  if (!meta) return null
  if (isTerminalStatus(meta.status)) return meta
  const next = await appendEvent(
    id,
    'resumed',
    {
      via: input.via,
      sessionId: input.sessionId,
      ...(input.reason ? { reason: input.reason } : {}),
    },
    now,
    ownerCanonicalUser,
  )
  if (next?.status === 'running') await reactivateUserStoppedAncestors(next, now)
  return next
}

export async function markRebuilt(
  id: string,
  input: { via: TaskRunRebuiltEvent['via']; sessionId: string; reason?: string },
  now = Date.now(),
  ownerCanonicalUser?: string,
): Promise<TaskRunMeta | null> {
  // Terminal is absorbing here too — see markResumed. A cold rebuild revives a
  // run just as a resume does, so a late wake must not reach it either.
  const meta = await getTaskRun(id, ownerCanonicalUser)
  if (!meta) return null
  if (isTerminalStatus(meta.status)) return meta
  const next = await appendEvent(
    id,
    'rebuilt',
    {
      via: input.via,
      sessionId: input.sessionId,
      ...(input.reason ? { reason: input.reason } : {}),
    },
    now,
    ownerCanonicalUser,
  )
  if (next?.status === 'running') await reactivateUserStoppedAncestors(next, now)
  return next
}

/** A /stop parks every running run in the calling chat's tree at
 *  `waiting{reason:'user-stop'}` with NO wake descriptor — unlike child-join /
 *  timer / awaiting-reply, a user-stopped run has no self-revival path, and a
 *  user-stopped ROOT is not even reported by the watchdog (open roots are not
 *  "stranded"). So once any descendant comes back to life — main re-engages a
 *  child via `Message`, a queued child fires, a child-join wake lands — the
 *  ancestor's user-stop is stale: nothing else will ever clear it, and the live
 *  task card stays frozen at "等待中" while its subtree actively works.
 *
 *  Walk up from the reactivated run and flip each `waiting{user-stop}` /
 *  `waiting{requester-hold}` ancestor back to running, restoring its OWN
 *  lastSessionId (never the descendant's session — the root's session is its
 *  channel turn, a child's is a bg session; conflating them would mis-point a
 *  later /stop or cancel abort). requester-hold joined 2026-08-13: an
 *  orchestrator-held goal root (TaskUpdate wait on the root) is the same shape
 *  of wake-less deliberate park, and dispatching the goal's next stage IS its
 *  resume path — without reactivation the root stays waiting under a working
 *  subtree. Stop at the first ancestor waiting for any OTHER reason: it owns a
 *  legitimate wake and absorbs the subtree-active signal through its own path,
 *  so reaching past it would corrupt that wait. */
async function reactivateUserStoppedAncestors(
  run: TaskRunMeta,
  now: number,
): Promise<void> {
  const owner = run.ownerCanonicalUser
  let parentId = run.parentRunId
  // Tree-depth bound: a malformed parent cycle must not loop forever.
  for (let hops = 0; parentId && hops < 64; hops++) {
    const ancestor = await getTaskRun(parentId, owner)
    if (!ancestor) break
    if (
      ancestor.status !== 'waiting' ||
      (ancestor.waitReason !== 'user-stop' && ancestor.waitReason !== 'requester-hold')
    ) break
    const sessionId = ancestor.lastSessionId ?? ancestor.currentSessionId
    if (!sessionId) break
    await appendEvent(
      ancestor.id,
      'resumed',
      { via: 'descendant-active', reason: `descendant ${run.id} resumed`, sessionId },
      now,
      owner,
    )
    parentId = ancestor.parentRunId
  }
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
  return appendEvent(
    id,
    'rejected',
    { byRole: input.byRole, feedback: input.feedback },
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
    meta.status === 'waiting' ||
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

// Charge token usage to a run, accumulated into `meta.tokenUsage`. Called once
// per query turn from `query.ts` with the turn's provider usage. Best-effort
// like the rest of the ledger: a missing run / all-zero delta is a no-op. The
// task card sums this over a root's descendants (the root itself excluded) to
// report what the subtasks cost.
export async function addTaskRunUsage(
  id: string,
  delta: TaskRunUsageTotals,
  now = Date.now(),
  ownerCanonicalUser?: string,
): Promise<TaskRunMeta | null> {
  if (delta.input === 0 && delta.output === 0 && delta.cacheRead === 0 && delta.cacheCreate === 0) {
    return null
  }
  return appendEvent(
    id,
    'usage',
    {
      input: delta.input,
      output: delta.output,
      cacheRead: delta.cacheRead,
      cacheCreate: delta.cacheCreate,
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
      lastSessionId: event.sessionId,
      startedAt: next.startedAt ?? event.ts,
    }
  }
  if (isResumedEvent(event) || isRebuiltEvent(event)) {
    // Terminal is an absorbing state for revival events, mirroring `started`'s
    // guard in markStarted. The mark* helpers refuse to append these on a
    // terminal run at all; this is the structural half of the same rule, so a
    // future append path that skips them cannot resurrect a settled run by
    // hitting the unconditional `status: 'running'` below.
    if (isTerminalStatus(next.status)) return next
    return {
      ...next,
      status: 'running',
      currentSessionId: event.sessionId,
      lastSessionId: event.sessionId,
      wake: consumeWake(next.wake),
      // A running run holds no wait: leaving the prior park's reason/timestamp
      // behind reads as "waiting" to anything that snapshots meta fields
      // without re-checking status (every current consumer status-gates, but
      // the stale pair was already a trap — surfaced by the requester-hold
      // resume test, same residue existed for user-stop reactivation).
      waitReason: undefined,
      waitingAt: undefined,
    }
  }
  if (isRejectedEvent(event)) {
    return {
      ...next,
      status: 'running',
      currentSessionId: next.currentSessionId ?? next.lastSessionId ?? null,
      deliveredAt: undefined,
      outcome: undefined,
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
  if (isWaitingEvent(event)) {
    return {
      ...next,
      status: 'waiting',
      currentSessionId: null,
      waitingAt: event.ts,
      waitReason: normalizeWaitReason(event.reason),
      ...(event.wake ? { wake: event.wake } : {}),
    }
  }
  if (isCheckpointEvent(event)) {
    return {
      ...next,
      checkpoint: event.checkpoint,
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
  if (isUsageEvent(event)) {
    const prior = next.tokenUsage ?? { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }
    return {
      ...next,
      tokenUsage: {
        input: prior.input + event.input,
        output: prior.output + event.output,
        cacheRead: prior.cacheRead + event.cacheRead,
        cacheCreate: prior.cacheCreate + event.cacheCreate,
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

function isRejectedEvent(event: TaskRunEvent): event is import('./types.js').TaskRunRejectedEvent {
  return event.kind === 'rejected' && typeof (event as { feedback?: unknown }).feedback === 'string'
}

function isCancelledEvent(event: TaskRunEvent): event is TaskRunCancelledEvent {
  return event.kind === 'cancelled'
}

function isWaitingEvent(event: TaskRunEvent): event is TaskRunWaitingEvent {
  // 'paused' / 'requester-pause' are the pre-rename spellings still present in
  // ledgers written before the wait rename; read them as waiting.
  const kind = (event as { kind?: unknown }).kind
  if (kind !== 'waiting' && kind !== 'paused') return false
  const reason = (event as { reason?: unknown }).reason
  return reason === 'user-stop' ||
    reason === 'requester-hold' ||
    reason === 'requester-pause' ||
    reason === 'child-join' ||
    reason === 'timer' ||
    reason === 'awaiting-reply'
}

function normalizeWaitReason(reason: TaskRunWaitingEvent['reason']): TaskRunWaitingEvent['reason'] {
  return (reason as string) === 'requester-pause' ? 'requester-hold' : reason
}

function isResumedEvent(event: TaskRunEvent): event is TaskRunResumedEvent {
  return event.kind === 'resumed' && typeof (event as { sessionId?: unknown }).sessionId === 'string'
}

function isRebuiltEvent(event: TaskRunEvent): event is TaskRunRebuiltEvent {
  return event.kind === 'rebuilt' && typeof (event as { sessionId?: unknown }).sessionId === 'string'
}

function isCheckpointEvent(event: TaskRunEvent): event is import('./types.js').TaskRunCheckpointEvent {
  return event.kind === 'checkpoint' && typeof (event as { checkpoint?: unknown }).checkpoint === 'string'
}

function consumeWake(wake: TaskRunWakeSpec | undefined): TaskRunWakeSpec | undefined {
  if (!wake) return undefined
  return { ...wake, consumed: true } as TaskRunWakeSpec
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

function isUsageEvent(event: TaskRunEvent): event is TaskRunUsageEvent {
  return event.kind === 'usage'
    && typeof (event as { input?: unknown }).input === 'number'
    && typeof (event as { output?: unknown }).output === 'number'
}

export async function getTaskRun(
  id: string,
  ownerCanonicalUser?: string,
): Promise<TaskRunMeta | null> {
  if (ownerCanonicalUser) {
    return loadMetaFile(ownerCanonicalUser, id)
  }
  let users
  try {
    users = await readdir(usersRoot(), { withFileTypes: true })
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
  let events = raw
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as TaskRunEvent)
  if (options.kinds) {
    const wanted = new Set(options.kinds)
    events = events.filter(event => wanted.has(event.kind))
  }
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
  outcome: { ok?: boolean; summary?: string } = {},
): Promise<CloseRootResult> {
  const root = await getTaskRun(rootRunId, ownerCanonicalUser)
  if (!root) return { closed: false, reason: 'not-found' }
  if (taskRunKind(root) !== 'root') return { closed: false, reason: 'not-root' }
  if (isTerminalStatus(root.status)) return { closed: false, reason: 'already-terminal' }
  const obligations = await getRootObligations(rootRunId, ownerCanonicalUser)
  if (obligations.openRunIds.length > 0 || obligations.pendingDispatchIds.length > 0) {
    return { closed: false, reason: 'open-obligations', obligations }
  }
  // The summary is the user-facing conclusion: the task-card settlement
  // message renders it verbatim. It MUST be the caller's words — the old
  // hardcoded 'Delivered by main.' placeholder silently discarded the
  // orchestrator's full delivery report (links, results, caveats) the
  // moment PR22 made this field user-visible.
  const meta = await markFinished(
    root.id,
    {
      ok: outcome.ok ?? true,
      ...(outcome.summary ? { summary: outcome.summary } : {}),
    },
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
  let users
  try {
    users = await readdir(usersRoot(), { withFileTypes: true })
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
