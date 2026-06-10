export type TaskRunMode = 'blocking' | 'background'

export type TaskRunKind = 'root' | 'dispatch'

export type TaskRunStatus =
  | 'queued'
  | 'running'
  | 'blocked'
  | 'paused'
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
  outcome?: TaskRunOutcome
  createdAt: number
  startedAt?: number
  deliveredAt?: number
  terminalAt?: number
  updatedAt: number
  lastEventSeq: number
  latestProgress?: TaskRunProgressSnapshot
  artifactPaths?: string[]
}

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

export type TaskRunCancelledEvent = {
  seq: number
  ts: number
  kind: 'cancelled'
  reason?: string
}

export type TaskRunWatchdogReportEvent = {
  seq: number
  ts: number
  kind: 'watchdog-report'
  fingerprint: string
  findingKind: 'stranded' | 'unsettled-delivered'
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
  | TaskRunCancelledEvent
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
