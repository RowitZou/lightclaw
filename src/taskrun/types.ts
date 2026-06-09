export type TaskRunMode = 'blocking' | 'background'

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
}

export type TaskRunCreatedEvent = {
  seq: number
  ts: number
  kind: 'created'
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

export type TaskRunEvent =
  | TaskRunCreatedEvent
  | TaskRunStartedEvent
  | TaskRunFinishedEvent
  | ({
      seq: number
      ts: number
      kind: string
    } & Record<string, unknown>)
