import type { ChainState } from '../signal-bus/chain-state.js'

export type TaskRunMode = 'blocking' | 'background'

export type TaskRunKind = 'root' | 'dispatch'

export type TaskRunStatus =
  | 'queued'
  | 'running'
  | 'blocked'
  | 'waiting'
  // Worker-side conclusion reported, awaiting the caller's acceptance.
  // NOT terminal: a delivered run keeps pinning its root open until it is
  // accepted / rejected, which is what keeps an undelivered result visible.
  | 'delivered'
  | 'done'
  | 'failed'
  | 'cancelled'

export type TaskRunOutcome = {
  ok: boolean
  summary?: string
  error?: string
}

export type TaskRunMeta = {
  id: string
  kind?: TaskRunKind
  standing?: boolean
  parentRunId: string | null
  rootRunId: string
  chainId: string
  depth: number
  ownerCanonicalUser: string
  role: string
  callerRole: string
  callerSessionId: string
  title: string
  mode: TaskRunMode
  status: TaskRunStatus
  currentSessionId: string | null
  lastSessionId?: string
  // The sessionId a running worker drains its interjection queue under — its
  // chain-leaf sessionId, which is also its agent-loop ALS sessionId. Stable
  // across shifts, unlike `currentSessionId` (the per-shift bg-session
  // transcript locator). Requester/child messages to a running worker must
  // target THIS, not `currentSessionId`: a background worker runs under the
  // chain leaf while its transcript persists under a `bg-…-<fireUuid>`
  // session, so the two diverge. Unset for chain-less runs, where the drain
  // key falls back to `currentSessionId` (= the bg session) — matching the bg
  // runner's own `chainState?.path.at(-1)?.sessionId ?? sessionId`.
  interjectionSessionId?: string
  // Standing report code: the run's own, permanent ticket for surfacing a
  // result its requester is waiting on — non-blocking, does not conclude the
  // run, reusable for the run's whole life. Distinct from the one-shot reply
  // codes a requester's downward message mints (those live in an in-memory
  // registry and are consumed on use): a worker must be able to speak because
  // it HAS something to say, not only because it was spoken to. Minted at
  // creation for every run that has a requester (roots have none — main
  // answers the user directly) and persisted here, so it survives the daemon
  // restart that wipes the one-shot registry.
  reportCode?: string
  // The chain snapshot this run was dispatched with — the fire's own
  // `deriveChildChainState` output, recorded at creation and immutable for the
  // life of the run. It is the durable home for four things every shift needs:
  // owner-secret eligibility (`resolveDispatchedFireSecrets` reads
  // `path.at(-2)`), dispatch chain guards (depth / cycle / privilege), progress
  // attribution (`[main → role]`), and bg-result routing back to a live
  // spawner. Before this field the ONLY copy lived on the backing
  // `BackgroundTaskEntry`, which the scheduler prunes the moment a oneshot fire
  // returns a terminal outcome — including the ordinary "worker parked at
  // TaskUpdate wait" case. So every shift after the first ran chain-less and
  // secret-less: `$BRAINPP_ACCESS_KEY_ID` vanished from Bash between the
  // initial fire and every retry, and cluster jobs the retry submitted were
  // attributed to the daemon host's own account instead of the owner's
  // (2026-08-14). Evidence for a grant must outlive the schedule record that
  // happened to carry it; the ledger is the run's own durable state.
  chainState?: ChainState
  outcome?: TaskRunOutcome
  checkpoint?: string
  wake?: TaskRunWakeSpec
  createdAt: number
  startedAt?: number
  waitingAt?: number
  waitReason?: TaskRunWaitReason
  deliveredAt?: number
  terminalAt?: number
  updatedAt: number
  lastEventSeq: number
  latestProgress?: TaskRunProgressSnapshot
  artifactPaths?: string[]
  // Cumulative tokens this run spent, reduced from `usage` events. Omitted
  // until the first usage event lands (legacy runs / runs that never ran).
  tokenUsage?: TaskRunUsageTotals
}

export type TaskRunWaitReason =
  | 'user-stop'
  | 'requester-hold'
  | 'child-join'
  | 'timer'
  | 'awaiting-reply'

export type TaskRunWakeSpec =
  | { kind: 'child-join'; runId: string; consumed?: boolean }
  | { kind: 'timer'; at: number; dispatchId?: string; consumed?: boolean }
  | { kind: 'parent-reply'; timeoutAt: number; default: string; options?: string[]; consumed?: boolean }

export type TaskRunProgressSnapshot = {
  phase?: string
  label: string
  ts: number
}

// Cumulative token usage charged to one run (its own agent loop, summed across
// every turn / shift). A derived meta field reduced from `usage` events — see
// `addTaskRunUsage`. The task card sums this over a root's descendants to show
// what the subtasks cost (the root / main turn is excluded by the caller).
export type TaskRunUsageTotals = {
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
}

export type TaskRunCreatedEvent = {
  seq: number
  ts: number
  kind: 'created'
  taskRunKind?: TaskRunKind
  standing?: boolean
  objective: string
  role: string
  callerRole: string
  mode: TaskRunMode
  parentRunId: string | null
  chainId: string
  // Creation-time chain snapshot; `meta.chainState` is its reduction, so a meta
  // rebuilt from this event stream keeps the grant evidence.
  chainState?: ChainState
}

export type TaskRunStartedEvent = {
  seq: number
  ts: number
  kind: 'started'
  sessionId: string
}

export type TaskRunFinishedEvent = {
  seq: number
  ts: number
  kind: 'finished'
  ok: boolean
  summary?: string
  error?: string
}

export type TaskRunProgressEvent = {
  seq: number
  ts: number
  kind: 'progress'
  phase?: string
  label: string
}

export type TaskRunUsageEvent = {
  seq: number
  ts: number
  kind: 'usage'
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
}

export type TaskRunArtifactEvent = {
  seq: number
  ts: number
  kind: 'artifact'
  path?: string
  token?: string
  artifactKind?: string
  label?: string
}

export type TaskRunDeliveredEvent = {
  seq: number
  ts: number
  kind: 'delivered'
  ok: boolean
  summary?: string
  error?: string
}

export type TaskRunAcceptedEvent = {
  seq: number
  ts: number
  kind: 'accepted'
  byRole: string
  auto?: boolean
}

export type TaskRunRejectedEvent = {
  seq: number
  ts: number
  kind: 'rejected'
  byRole: string
  feedback: string
}

export type TaskRunCheckpointEvent = {
  seq: number
  ts: number
  kind: 'checkpoint'
  checkpoint: string
}

export type TaskRunCancelledEvent = {
  seq: number
  ts: number
  kind: 'cancelled'
  reason?: string
}

export type TaskRunWaitingEvent = {
  seq: number
  ts: number
  kind: 'waiting'
  reason: TaskRunWaitReason
  bySessionId?: string
  wake?: TaskRunWakeSpec
}

export type TaskRunResumedEvent = {
  seq: number
  ts: number
  kind: 'resumed'
  via: 'reject' | 'child-join' | 'timer' | 'answer' | 'message' | 'crash-recovery' | 'watchdog' | 'descendant-active'
  reason?: string
  sessionId: string
}

export type TaskRunRebuiltEvent = {
  seq: number
  ts: number
  kind: 'rebuilt'
  via: TaskRunResumedEvent['via']
  reason?: string
  sessionId: string
}

export type TaskRunWatchdogReportEvent = {
  seq: number
  ts: number
  kind: 'watchdog-report'
  fingerprint: string
  findingKind: 'stranded' | 'unsettled-delivered' | 'held' | 'dead-wake-source' | 'idle-root'
  rootRunId: string
}

export type TaskRunEscalatedEvent = {
  seq: number
  ts: number
  kind: 'escalated'
  fingerprint: string
  reason: 'stalled-reconcile' | 'delivery-failed'
  detail?: string
}

export type TaskRunEvent =
  | TaskRunCreatedEvent
  | TaskRunStartedEvent
  | TaskRunDeliveredEvent
  | TaskRunAcceptedEvent
  | TaskRunRejectedEvent
  | TaskRunCheckpointEvent
  | TaskRunCancelledEvent
  | TaskRunWaitingEvent
  | TaskRunResumedEvent
  | TaskRunRebuiltEvent
  | TaskRunWatchdogReportEvent
  | TaskRunEscalatedEvent
  | TaskRunFinishedEvent
  | TaskRunProgressEvent
  | TaskRunArtifactEvent
  | TaskRunUsageEvent
  | ({
      seq: number
      ts: number
      kind: string
    } & Record<string, unknown>)
