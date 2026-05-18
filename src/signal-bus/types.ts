import type { AgentType } from '../agents/types.js'
import type { ScheduleSpec } from '../background-task/types.js'
import type { PendingAttachment } from '../channels/types.js'
import type { ChainState } from './chain-state.js'

export type DispatchRole =
  | 'generalist'
  | 'localExplorer'
  | 'webSearcher'
  | 'feishuSecretary'
  | 'coder'
  | 'archivist'
  | 'reviewer'
export type DispatchMode = 'blocking' | 'background'
export type DispatchSchedule = 'now' | ScheduleSpec

export type AgentSignalKind =
  | 'dispatch'
  | 'interjection'
  | 'wake'
  | 'notification'
  | 'turn'
  | 'progress'

export type SignalEndpoint =
  | { kind: 'user'; id: string }
  | { kind: 'role'; id: AgentType | '*' | 'main'; sessionId?: string; broadcast?: 'chain' | 'none' }
  | { kind: 'channel'; id: 'feishu' | 'terminal' }
  | { kind: 'scheduler' }

export type SignalPayload = {
  dispatch: {
    role: DispatchRole
    internalRole?: AgentType
    prompt: string
    schedule: DispatchSchedule
    mode: DispatchMode
    resumeFrom?: string
    allowed_tools?: string[]
    label?: string
    chainState?: ChainState
  }
  interjection: {
    text: string
    senderOpenId?: string
    senderName?: string
    messageId?: string
    attachments?: PendingAttachment[]
    quotedSummary?: string
    arrivedAt: number
    source?: 'user' | 'background-task'
  }
  wake: never
  notification:
    | { kind: 'reply'; text: string }
    | {
        kind: 'card'
        fromTool: 'Notify' | 'BackgroundTaskCard'
        severity?: 'info' | 'warning' | 'urgent'
        title?: string
        body?: string
        target?: 'this-chat' | 'user-dm'
        cardData?: unknown
      }
    | {
        kind: 'background-result'
        dispatchId: string
        label: string
        outcome: 'success' | 'failed' | 'permission-denied' | 'aborted'
        result: string
        priorPromptNotice?: string
      }
    | { kind: 'abort'; abortReason?: string }
    | { kind: 'system-notice'; text: string; severity: 'info' | 'warning' | 'error' }
  turn: {
    text: string
    attachments?: PendingAttachment[]
    senderOpenId?: string
    senderName?: string
    messageId?: string
  }
  progress: {
    milestoneLabel: string
    todoId?: string
    completedCount: number
    totalCount: number
  }
}

export type AgentSignal<K extends AgentSignalKind = AgentSignalKind> = {
  kind: K
  from: SignalEndpoint
  to: SignalEndpoint
  payload: SignalPayload[K]
  timing: {
    emittedAt: number
    deadline?: number
  }
  chainId?: string
  parentDispatchId?: string
}

export function getChainState(signal: AgentSignal<'dispatch'>): ChainState | undefined {
  return signal.payload.chainState
}
