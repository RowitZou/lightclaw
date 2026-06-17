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
  via: 'reject' | 'child-join' | 'timer' | 'answer' | 'message' | 'crash-recovery' | 'watchdog'
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
  | ({
      seq: number
      ts: number
      kind: string
    } & Record<string, unknown>)
