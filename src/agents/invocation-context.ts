import type { PermissionApprover } from '../permission/types.js'
import type { CanUseToolFn } from '../tool.js'
import type { Role } from './types.js'
import type { ChainState } from '../signal-bus/chain-state.js'
import type {
  Message,
  ToolExecutionEvent,
  UserContentBlock,
} from '../types.js'

export type InterjectionPendingAttachment = {
  kind: string
  messageId: string
  mediaKey: unknown
  fileName: string
  quotedFromMessageId?: string
}

export type InterjectionEntry = {
  messageId: string
  senderOpenId: string
  senderName?: string
  text: string
  arrivedAt: number
  triggeredAutoDeny?: boolean
  quotedSummary?: string
  pendingAttachments?: InterjectionPendingAttachment[]
  attachmentPaths?: string[]
  source?: 'user' | 'background-task'
  /** Root TaskRun behind a background-task entry; the rescue replay carries
   *  it onto the synthetic turn so its narration lands on the task card. */
  taskCardRoot?: { owner: string; rootRunId: string }
}

export type InvocationContext = {
  onTextDelta?(text: string): void
  onToolUse?(event: { name: string; input: Record<string, unknown> }): void
  onToolResult?(event: ToolExecutionEvent): void
  onAssistantTurn?(text: string): Promise<void> | void
  onCompactStart?(): void
  onCompactEnd?(result: { removedCount: number; summaryTokens: number }): void
  onCompactError?(message: string): void
  channelContext?: string
  interjectionDrain?: () => Promise<InterjectionEntry[]> | InterjectionEntry[]
  /**
   * Drain and apply write-slash commands (`/mode`, `/model`, `/rules allow`,
   * ...) that arrived while this turn was in flight. query.ts invokes it at
   * every tool-call boundary so a mid-turn slash takes effect for the turn's
   * remaining tool calls instead of waiting for the whole turn to finish.
   * The channel runner's implementation dispatches each queued slash and
   * posts its output as a channel notice; it never throws.
   */
  slashDrain?: () => Promise<void> | void
  /**
   * Persist a batch of newly-produced transcript messages incrementally.
   * query.ts invokes it at every tool-call boundary (after the assistant +
   * tool_result pair is on the in-memory array) and after the final end-turn
   * assistant message, so a mid-turn crash leaves a coherent partial
   * transcript on disk instead of losing the whole turn. Each batch is always
   * a valid message sub-sequence — never an orphan assistant tool_use without
   * its tool_result. The implementation appends the batch atomically; query.ts
   * catches and logs a throw, never surfacing it to the turn.
   */
  persistMessages?: (messages: Message[]) => Promise<void> | void
  /**
   * Overwrite the whole on-disk transcript with `messages`. query.ts invokes
   * it once after a compaction has rewritten the message prefix (the
   * incremental append cursor is then stale), then resumes incremental
   * `persistMessages` from the compacted baseline. Without this callback a
   * mid-turn compaction stops incremental persistence for the rest of the
   * query — so any caller that wires `persistMessages` should wire this too.
   */
  rewriteMessages?: (messages: Message[]) => Promise<void> | void
  interjectionRenderer?: (
    entries: InterjectionEntry[],
    context: {
      originalUserText: string
      completedToolUses: Array<{ name: string; brief: string }>
    },
  ) => UserContentBlock[]
  permissionApprover?: PermissionApprover
  canUseTool?: CanUseToolFn
  cacheBreakpointMessageIndex?: number
  signal?: AbortSignal
  noAutoMemory?: boolean
  ephemeral?: boolean
  subagentLabel?: string
  systemPromptOverride?: string
  currentRoleOverride?: Role
  chainState?: ChainState
}

export function emptyInvocationContext(): InvocationContext {
  return {}
}

export function channelInvocationContext(
  input: InvocationContext,
): InvocationContext {
  return { ...input }
}

export function forkInvocationContext(input: {
  systemPrompt: string
  canUseTool: CanUseToolFn
  cacheBreakpointMessageIndex?: number
  signal?: AbortSignal
  subagentLabel?: string
  currentRoleOverride?: Role
  chainState?: ChainState
  // Optional drain callback. When set, query.ts pulls pending interjections
  // at tool boundaries the same way the channel runner does. Used by
  // workers that want to receive bg-dispatch results spawned by themselves
  // (see scheduler spawner-aware delivery).
  interjectionDrain?: () => Promise<InterjectionEntry[]> | InterjectionEntry[]
  // Optional per-assistant-turn callback. query.ts invokes it with the
  // worker's full collected text after each turn. Used by the read-only
  // observability stream that forwards worker activity to the chat that
  // initiated the chain (now the worker-progress forwarder in src/taskrun/worker-progress.ts).
  onAssistantTurn?: InvocationContext['onAssistantTurn']
  // Optional incremental transcript persistence callbacks (see
  // InvocationContext.persistMessages / rewriteMessages). Background fires
  // wire these so a crash mid-fire leaves a partial bg-session transcript on
  // disk, and a mid-fire compaction resyncs it instead of stopping flushes.
  persistMessages?: InvocationContext['persistMessages']
  rewriteMessages?: InvocationContext['rewriteMessages']
}): InvocationContext {
  return {
    systemPromptOverride: input.systemPrompt,
    canUseTool: input.canUseTool,
    cacheBreakpointMessageIndex: input.cacheBreakpointMessageIndex,
    signal: input.signal,
    subagentLabel: input.subagentLabel,
    currentRoleOverride: input.currentRoleOverride,
    chainState: input.chainState,
    ...(input.interjectionDrain ? { interjectionDrain: input.interjectionDrain } : {}),
    ...(input.onAssistantTurn ? { onAssistantTurn: input.onAssistantTurn } : {}),
    ...(input.persistMessages ? { persistMessages: input.persistMessages } : {}),
    ...(input.rewriteMessages ? { rewriteMessages: input.rewriteMessages } : {}),
  }
}

export function freshInvocationContext(): InvocationContext {
  return {
    noAutoMemory: true,
    ephemeral: true,
  }
}
