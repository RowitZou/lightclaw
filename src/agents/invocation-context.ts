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
  /** True when this entry is framework-minted, not a genuine platform inbound:
   *  its `messageId` / `senderOpenId` are synthetic (`taskrun-ask-…` /
   *  `taskrun:…` / `bg-…`) and the platform never saw them. Anchoring a reply
   *  to one makes im.message.reply 400 (code 99992354) and renders an invalid
   *  card at/person, so the reply-anchor + leftover-replay paths must treat
   *  these as non-addressable. Independent of `source` — a `source:'user'`
   *  taskrun-ask is still synthetic. Absent/false on real user interjections. */
  synthetic?: boolean
  /** Root TaskRun behind a background-task entry; the rescue replay carries
   *  it onto the synthetic turn so its narration lands on the task card. */
  taskCardRoot?: { owner: string; rootRunId: string }
  /** True when this entry is only meaningful to the in-flight turn it was
   *  pushed into (e.g. a recall withdrawal note advising the LIVE turn that an
   *  already-injected interjection was retracted). If the turn ends before the
   *  next tool boundary drains it, the entry is dropped by `unmarkInFlight`
   *  instead of being rescued as a fresh turn — replayed standalone it would
   *  open a new turn with "continue the current task" and no task in flight.
   *  Distinct from `synthetic`: bg-result / taskrun wakes are synthetic but
   *  carry real deliveries and MUST be rescued. */
  ephemeral?: boolean
}

/**
 * True when this interjection is framework-minted, not a genuine platform
 * inbound — so its `messageId` / `senderOpenId` are non-addressable and a
 * reply must never anchor on them. Two cases, both non-addressable:
 *  - `source: 'background-task'` — bg-result / reconcile wakes (never a real
 *    platform message by construction).
 *  - `synthetic: true` — taskrun-ask / worker-reply, which are `source:'user'`
 *    (the model reads them as questions/answers to settle) yet carry a
 *    synthetic `taskrun-ask-…` id the platform never saw.
 * Real user interjections are `source:'user'`/undefined AND not synthetic.
 */
export function isSyntheticInterjection(
  entry: Pick<InterjectionEntry, 'synthetic' | 'source'>,
): boolean {
  return entry.synthetic === true || entry.source === 'background-task'
}

export type InvocationContext = {
  onTextDelta?(text: string): void
  onToolUse?(event: { name: string; input: Record<string, unknown> }): void
  onToolResult?(event: ToolExecutionEvent): void
  onAssistantTurn?(text: string, meta?: { isFinal: boolean }): Promise<void> | void
  onCompactStart?(): void
  onCompactEnd?(result: { removedCount: number; summaryTokens: number }): void
  onCompactError?(message: string): void
  channelContext?: string
  interjectionDrain?: () => Promise<InterjectionEntry[]> | InterjectionEntry[]
  /**
   * Drain and apply write-slash commands (`/config mode`, `/config model`, `/config rule add`,
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

/**
 * The renderer every dispatched / resumed worker uses for the downlink
 * messages it drains (requester Message, sub-worker bg-result, taskrun-ask /
 * worker-reply, reconcile wake). Each entry's `text` is already a
 * self-contained framework block (<requester-message> / <background-task-result>
 * / <taskrun-ask> / <worker-reply> / <taskrun-reconcile>), so emit them raw —
 * this mirrors the channel runner's `source === 'background-task'` branch, and
 * must NOT wrap in <user-interjection> (that channel wrapper is for bare user
 * chat; these blocks carry their own guidance). Shared by dispatched-agent and
 * resume so the two delivery paths can never render the same entries
 * differently.
 */
export function workerInterjectionRenderer(): NonNullable<
  InvocationContext['interjectionRenderer']
> {
  return entries => [
    { type: 'text' as const, text: entries.map(entry => entry.text).join('\n\n') },
  ]
}

export function forkInvocationContext(input: {
  systemPrompt: string
  canUseTool: CanUseToolFn
  cacheBreakpointMessageIndex?: number
  signal?: AbortSignal
  subagentLabel?: string
  currentRoleOverride?: Role
  chainState?: ChainState
  // Mid-turn message delivery. `drain` and `renderer` are ONE unit on purpose:
  // query.ts stamps metadata.interjectionEntries whenever drain yields entries,
  // but it only makes them model-visible through the renderer. A drain wired
  // WITHOUT a renderer silently records "delivered" metadata while the model
  // never sees the message — the resume.ts blind spot (2026-06-17), the same
  // shape that bit dispatched-agent earlier. Coupling them here makes that
  // half-wiring unrepresentable; query.ts keeps a runtime backstop for any
  // caller that bypasses this builder. Use workerInterjectionRenderer() for the
  // renderer unless a path genuinely needs different framing.
  interjection?: {
    drain: () => Promise<InterjectionEntry[]> | InterjectionEntry[]
    renderer: NonNullable<InvocationContext['interjectionRenderer']>
  }
  // Optional per-assistant-turn callback. query.ts invokes it with the
  // worker's full collected text after each turn. Used by the read-only
  // observability stream that forwards worker activity to the chat that
  // initiated the chain (now the worker-progress forwarder in src/taskrun/worker-progress.ts).
  onAssistantTurn?: InvocationContext['onAssistantTurn']
  // Optional per-generation-delta callback. query.ts invokes it with each token
  // chunk during a turn. Dispatched workers wire it to stream their live text
  // into their node's element on the root's task card (in-card model).
  onTextDelta?: InvocationContext['onTextDelta']
  // Optional incremental transcript persistence callbacks (see
  // InvocationContext.persistMessages / rewriteMessages). Background fires wire
  // these so a crash mid-fire leaves a partial bg-session transcript on disk,
  // and a mid-fire compaction resyncs it instead of stopping flushes. These
  // stay independently optional (not coupled like `interjection`): a persist-
  // only caller is legitimate — the channel runner drives its own rewrite cycle
  // — and a missing rewrite degrades to "stop persisting after a compaction",
  // not to the silent never-shown-to-model failure the interjection pair has.
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
    ...(input.interjection
      ? {
          interjectionDrain: input.interjection.drain,
          interjectionRenderer: input.interjection.renderer,
        }
      : {}),
    ...(input.onAssistantTurn ? { onAssistantTurn: input.onAssistantTurn } : {}),
    ...(input.onTextDelta ? { onTextDelta: input.onTextDelta } : {}),
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
