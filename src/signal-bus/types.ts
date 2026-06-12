import type { AgentType } from '../agents/types.js'
import type { ScheduleSpec } from '../background-task/types.js'
import type { PendingAttachment } from '../channels/types.js'
import type { ChainState } from './chain-state.js'

// Dispatch.role accepts any dispatchable AgentType, including user-defined
// roles registered at `<lightclawHome>/roles/<name>/ROLE.md`. Runtime
// validation in `executeDispatch` rejects unknown / orchestrator / internal
// roles; the type is intentionally open so the LLM can pass user-defined
// worker names without a zod enum reject. Bundled worker names live in
// `BUNDLED_AGENT_TYPES` (`agents/types.ts`).
export type DispatchRole = AgentType
export type DispatchMode = 'background'
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
        ownerOpenId: string
        // Canonical owner of the backing TaskRun — lets receivers resolve
        // the run's root without scanning every user's ledger.
        ownerCanonicalUser?: string
        dispatchId: string
        label: string
        outcome: 'success' | 'failed' | 'permission-denied' | 'aborted'
        result: string
        priorPromptNotice?: string
        // Durable TaskRun behind this fire — the receiver settles it
        // (accept / reject) via TaskUpdate. Absent when the best-effort
        // store write failed at dispatch/fire time.
        taskRunId?: string
      }
    | {
        kind: 'background-exec-result'
        canonicalUser: string
        // Owner's channel open_id (real `ou_xxx` for Feishu) resolved at
        // publish time. The DM-idle synthetic NormalizedChannelMessage
        // path uses this for `senderOpenId`; without it the receiver
        // misreads `canonicalUser` as an open_id, finds no binding, and
        // renders a pairing-application card to the very user who ran
        // the bg-exec job. Required — publisher (`watcher.ts`) skips
        // emission entirely when the owner has no resolvable open_id,
        // mirroring `scheduler.deliverCompletion`'s `background-result`
        // ownerOpenId contract.
        ownerOpenId: string
        jobId: string
        status: 'completed' | 'killed' | 'lost'
        exitCode?: number
        command: string
        outFile: string
        errFile: string
        outputTail: { stdoutTail?: string; stderrTail?: string }
      }
    | { kind: 'abort'; abortReason?: string; canonicalUser?: string }
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
    // Role chain from main down to the triggering role, derived from
    // chainState.path at publish time. Single-element ['main'] means
    // the main agent triggered it directly; ['main', 'webSearcher']
    // means a dispatched webSearcher TodoWrite produced the progress.
    // Subscribers use this to render attribution (e.g. breadcrumb prefix).
    chainPath?: string[]
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
