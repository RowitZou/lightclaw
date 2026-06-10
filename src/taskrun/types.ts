export type TaskRunMode = 'blocking' | 'background'

export type TaskRunKind = 'root' | 'dispatch'

export type TaskRunStatus =
  | 'queued'
  | 'running'
  | 'blocked'
  | 'paused'
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

export type TaskRunEvent =
  | TaskRunCreatedEvent
  | TaskRunStartedEvent
  | TaskRunFinishedEvent
  | TaskRunProgressEvent
  | TaskRunArtifactEvent
  | ({
      seq: number
      ts: number
      kind: string
    } & Record<string, unknown>)
