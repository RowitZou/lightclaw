
import { type LightClawConfig } from './config.js'
import { streamChat as defaultStreamChat } from './api.js'
import { IdleStreamError, isTransientError } from './transient-error.js'
import {
  emptyInvocationContext,
  type InterjectionEntry,
  type InvocationContext,
} from './agents/invocation-context.js'
import { resolveRolePolicy } from './agents/role-presets.js'
import type { Role } from './agents/types.js'
import { resolveHooks } from './agents/hook-registry.js'
import type { HookContext, RenderedPrompt } from './agents/hooks/types.js'
import { runHook } from './hooks/index.js'
import {
  updateSessionMemory as defaultUpdateSessionMemory,
  type SessionMemoryUpdateInput,
} from './memory/session-memory.js'
import {
  collectAssistantText,
  createAssistantMessage,
  createUserMessage,
  getLastUuid,
  injectSystemReminderIntoLastUserMessage,
  toApiMessages,
} from './messages.js'
import { buildSystemPromptTemplate, renderSystemPrompt } from './prompt.js'
import { getProviderFor } from './provider/index.js'
import { formatModelSetupRequiredReply } from './model-setup.js'
import {
  resolveRoleMaxTurns,
  resolveRoleModel,
} from './model-resolution.js'
import {
  addSessionMemoryToolCall,
  addSessionMemoryTokens,
  addUsage,
  getAbortController,
  getCurrentEnabledSecrets,
  getCurrentUserId,
  getCwd,
  getRuntime,
  getSessionId,
  getSessionsDir,
  getSessionMemoryToolCallsSinceUpdate,
  getSessionMemoryTokensSinceUpdate,
  getSessionConfig,
  getTodos,
  incrementSessionMemoryUpdateCount,
  registerBackgroundTask,
  resetSessionMemoryCounters,
} from './state.js'
import {
  loadMeta,
  updateMetaSessionMemoryAt,
} from './session/storage.js'
import { getCurrentSessionContext } from './session-context.js'
import {
  buildTurnToolCatalog,
  type TurnToolCatalog,
} from './tools/deferred-loading.js'
import { appendUsage } from './usage/storage.js'
import { openApiLogger, runWithApiLogger } from './api-logs/storage.js'
import {
  findToolByName,
  toolToAPISchema,
  type Tool,
} from './tool.js'
import {
  dispatchToolCall,
  throwIfAborted,
  type DispatchContext,
  type ToolUseBlock,
} from './query-tool-dispatch.js'
import type {
  AssistantToolUseBlock,
  Message,
  UsageStats,
  UserContentBlock,
  UserToolResultBlock,
} from './types.js'
import type { AttachmentKind } from './provider/types.js'

// streamChat indirection so unit tests can drive the query loop with a fake
// event stream. Production code always uses the real implementation.
let streamChatImpl: typeof defaultStreamChat = defaultStreamChat

export function setStreamChatForTest(
  impl: typeof defaultStreamChat | null,
): void {
  streamChatImpl = impl ?? defaultStreamChat
}

// Backoff before a per-turn transient streamChat retry. A `let` + test seam
// so the unit test driving a transient failure does not actually wait.
let transientTurnRetryDelayMs = 800

export function setTransientTurnRetryDelayForTest(ms: number | null): void {
  transientTurnRetryDelayMs = ms ?? 800
}

// updateSessionMemory indirection so unit tests can observe and control
// session-memory write timing without a real LLM call. Production code always
// uses the real implementation.
let sessionMemoryUpdaterImpl: typeof defaultUpdateSessionMemory =
  defaultUpdateSessionMemory

export function setSessionMemoryUpdaterForTest(
  impl: typeof defaultUpdateSessionMemory | null,
): void {
  sessionMemoryUpdaterImpl = impl ?? defaultUpdateSessionMemory
}

type QueryParams = {
  role: Role
  invocation: InvocationContext
  messages: Message[]
  tools: Tool[]
  config?: LightClawConfig
  maxTurns?: number
  /**
   * Per-call override forwarded to every `streamChat()` inside this query
   * invocation. Channel runner sets this on a retry after a wire 4xx
   * attributed to the `inToolResult` position so the immediate retry
   * downgrades the offending kind via `finalizeToolResultBlocks` instead of
   * re-sending the same unsupported block. See provider/types.ts
   * `StreamChatParams.forceFallbackInToolResult` for the autopilot rationale.
   */
  forceFallbackInToolResult?: ReadonlySet<AttachmentKind>
}

let streamIdleCheckIntervalMs = 5_000

export function setStreamIdleCheckIntervalForTest(ms: number | null): void {
  streamIdleCheckIntervalMs = ms ?? 5_000
}

function streamIdleThresholds(
  config: LightClawConfig,
  provider: { idleTimeouts?: { ttfbMs?: number; interEventMs?: number } },
): { ttfbMs: number; interEventMs: number } {
  return {
    ttfbMs: provider.idleTimeouts?.ttfbMs ?? config.streamIdle.ttfbMs,
    interEventMs: provider.idleTimeouts?.interEventMs ?? config.streamIdle.interEventMs,
  }
}

function mergeUsage(base: UsageStats, next: UsageStats): UsageStats {
  return {
    input_tokens: (base.input_tokens ?? 0) + (next.input_tokens ?? 0),
    output_tokens: (base.output_tokens ?? 0) + (next.output_tokens ?? 0),
    cache_creation_input_tokens:
      (base.cache_creation_input_tokens ?? 0)
      + (next.cache_creation_input_tokens ?? 0),
    cache_read_input_tokens:
      (base.cache_read_input_tokens ?? 0)
      + (next.cache_read_input_tokens ?? 0),
  }
}

function renderInterjectionContent(
  invocation: InvocationContext,
  interjections: InterjectionEntry[],
  messages: Message[],
): UserContentBlock[] {
  return invocation.interjectionRenderer?.(interjections, {
    originalUserText: extractOriginalUserText(messages),
    completedToolUses: extractCompletedToolUses(messages),
  }) ?? []
}

function extractOriginalUserText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message.type !== 'user') continue
    const text = userContentToText(message.message.content)
    if (!text) continue
    if (text.startsWith('<user-interjection>')) continue
    return text
  }
  return ''
}

function extractCompletedToolUses(
  messages: Message[],
): Array<{ name: string; brief: string }> {
  const completed = new Set<string>()
  for (const message of messages) {
    if (message.type !== 'user' || !Array.isArray(message.message.content)) continue
    for (const block of message.message.content) {
      if (block.type === 'tool_result') {
        completed.add(block.tool_use_id)
      }
    }
  }

  const out: Array<{ name: string; brief: string }> = []
  for (const message of messages) {
    if (message.type !== 'assistant') continue
    for (const block of message.message.content) {
      if (block.type !== 'tool_use' || !completed.has(block.id)) continue
      out.push({
        name: block.name,
        brief: summarizeToolInput(block),
      })
    }
  }
  return out
}

function userContentToText(content: string | UserContentBlock[]): string {
  if (typeof content === 'string') return content
  return content
    .filter((block): block is { type: 'text'; text: string } =>
      block.type === 'text' && typeof block.text === 'string',
    )
    .map(block => block.text)
    .join('\n')
}

function summarizeToolInput(block: AssistantToolUseBlock): string {
  const raw = JSON.stringify(block.input)
  if (raw.length <= 120) return raw
  return `${raw.slice(0, 117)}...`
}

// Dogfood 5/29 Bug 2 empty-stop backstop. Injected as a user message after a
// contentless end_turn that is never a finished state: a turn that left a todo
// in_progress, OR a dispatched worker's turn (its final reply IS its delivery,
// so an empty one hands its requester nothing). Neutral framing on purpose: the
// harness cannot tell a spurious stop (next step was clear) from a genuine
// block (needs input), so it does not pre-decide — it refuses the silent empty
// stop and hands control back, letting the model either take the next step or
// articulate the blocker in real words. Either outcome beats a blank turn that
// reaches no one. Wording is trigger-neutral (no todo / no audience word) so it
// reads correctly for both triggers. English to match the system-prompt todo
// reminder; this is a framework reminder, not the user's words.
const EMPTY_STOP_RESCUE_REMINDER = [
  '<system-reminder>',
  "You ended your turn without any output (no message, no tool call). An empty turn is never a finished state. Either take the next concrete step toward completing the work, or — if you genuinely cannot proceed without input — say so plainly and state exactly what you need to continue. Do not end the turn empty again.",
  '</system-reminder>',
].join('\n')

export async function query(params: QueryParams): Promise<{
  messages: Message[]
  /**
   * Accumulated non-empty text from every assistant turn in this query loop,
   * joined with double-newlines. The model often delivers its real reply in
   * a turn that *also* emits a tool_use (e.g. final research output + a
   * closing TodoWrite to mark done), then ends turn empty after the
   * tool_result. Channels that send a single reply at end-of-query (feishu)
   * and Dispatch callers that bundle the subagent's response into a parent
   * tool_result both want to see *all* of the model's narration, not just
   * the literal last turn — otherwise the closing empty end_turn produces
   * "(no response)" while the long body block-above gets dropped.
   */
  assistantText: string
  /**
   * The worker's final reply only — the last non-empty assistant turn. This is
   * what a dispatched worker hands its requester (bg-result / child-join), so
   * the requester's context sees the deliverable rather than the full narration
   * trail. Prefers the clean no-tool end_turn when present; falls back to the
   * last tool-bearing turn's text when the run ended without one, so a worker
   * that wrote its result alongside a closing TaskUpdate-deliver and then ended
   * empty still hands over that result instead of "".
   */
  finalReplyText: string
  stopReason: string | null
  didCompact: boolean
  usage: UsageStats
}> {
  const config = params.config ?? getSessionConfig()
  const invocation = params.invocation ?? emptyInvocationContext()
  const rolePolicy = resolveRolePolicy(params.role)
  // Re-resolved at the top of every turn (see the loop below) so a mid-turn
  // `/model` — applied by slashDrain at a tool boundary, which mutates
  // config.defaultModel — takes effect for the rest of this query.
  let roleModel = resolveRoleModel(params.role, config)
  const currentSessionContext = getCurrentSessionContext()
  const modelSetupReply = modelSetupRequiredReply(
    params.role,
    config,
    roleModel,
    currentSessionContext?.currentUserId,
  )
  if (modelSetupReply) {
    const assistant = createAssistantMessage({
      content: [{ type: 'text', text: modelSetupReply }],
      stopReason: 'end_turn',
      usage: {},
      parentUuid: getLastUuid(params.messages),
    })
    return {
      messages: [...params.messages, assistant],
      assistantText: modelSetupReply,
      finalReplyText: modelSetupReply,
      stopReason: 'end_turn',
      didCompact: false,
      usage: {},
    }
  }
  if (currentSessionContext) {
    currentSessionContext.currentRole = invocation.currentRoleOverride ?? params.role
  }
  const lifecycleHooks = resolveHooks(params.role)
  const systemPromptOverride = invocation.systemPromptOverride
  const hasSystemPromptOverride = systemPromptOverride !== undefined
  const signal = invocation.signal ?? getAbortController().signal
  const apiLogKind = rolePolicy.kind === 'orchestrator' ? 'main' : 'subagent'
  // Mirror Claude Code CLI: no default cap on tool-use turns; loop runs until
  // the model emits end_turn (or until abort / context exhaustion). Callers
  // that need a hard ceiling pass it explicitly (e.g. memory extraction);
  // operators can opt into a global ceiling via config.turns.main.
  const maxTurns =
    params.maxTurns
    ?? resolveRoleMaxTurns(params.role, config)
    ?? config.turns.main
    ?? Number.POSITIVE_INFINITY
  const messages = [...params.messages]
  const assistantTexts: string[] = []
  let stopReason: string | null = null
  let didCompact = false
  let totalUsage: UsageStats = {}
  // Cursor into `messages` for incremental transcript persistence — the index
  // past which messages have not yet been handed to invocation.persistMessages.
  // Starts past the on-disk history prefix.
  let transcriptPersistCursor = params.messages.length
  // Set by markDidCompact when a compaction rewrites the message prefix;
  // consumed by the next flushTranscript, which resyncs the whole on-disk
  // transcript through rewriteMessages and then resumes incremental appends.
  let compactionRewritePending = false
  // Latched true only when a compaction happens but no rewriteMessages
  // callback is wired (or the resync write itself failed) — incremental
  // persistence then stops and the caller's end-of-query rewrite is the
  // source of truth.
  let transcriptFlushDisabled = false
  // Dogfood 5/29 Bug 2 empty-stop backstop guard. Set when a continuation
  // nudge is injected after a contentless end_turn that left a todo
  // in_progress; cleared by any later turn that produces real output (text or
  // a tool call). Two empty stops in a row are therefore NOT both rescued —
  // a model stuck emitting empties falls through to a normal end_turn instead
  // of looping forever — while a spurious stop after genuine progress can be
  // rescued again.
  let pendingEmptyStopRescue = false

  // Open per-query API logger and push it on the AsyncLocalStorage scope so
  // every nested streamChat call (main loop turns + recall + session-memory
  // + compact, plus subagent forks that open their own nested logger) writes
  // into this query's file. No-op when config.apiLogsEnabled is false (the
  // default).
  const apiLogger = openApiLogger({
    enabled: config.apiLogsEnabled,
    dir: config.paths.apiLogs,
    sessionId: getSessionId(),
  })
  return runWithApiLogger(apiLogger, () => queryInner())

  async function queryInner(): Promise<{
    messages: Message[]
    assistantText: string
    finalReplyText: string
    stopReason: string | null
    didCompact: boolean
    usage: UsageStats
  }> {

  // SessionMemory write — runs the threshold check and, when both the token
  // and tool_call accumulators have crossed, the LLM rewrite. Driven by the
  // two wrappers below: kickSessionMemoryUpdate (non-blocking, mid-turn tool
  // boundaries) and flushSessionMemoryUpdate (awaited at end_turn so the next
  // prompt build / a compaction boundary sees the fresh file). Failures are
  // logged, never raised.
  const maybeUpdateSessionMemory = async (snapshot: Message[]): Promise<void> => {
    if (
      !config.memory.extractor.enabled
      || !config.memory.session.enabled
      // Framework-internal roles (memoryExtractor / memoryCurator / skillCurator
      // / skillConsolidator) are post-turn maintenance passes with no chainState,
      // so childCtx.sessionId falls back to the triggering turn's sessionId
      // (dispatched-agent.ts). Writing session-memory under that shared id
      // clobbers the triggering session's own working-memory file — observed
      // when an auto-dream skillCurator pass overwrote a still-monitoring
      // background watcher's session-memory.md. These runs are one-shot,
      // fresh-context, and never resumed, so their session-memory is never read
      // back across runs; skip the write entirely rather than corrupt the
      // triggering session. (A rare mid-run compaction falls back to the
      // compaction summary itself for context.)
      || rolePolicy.kind === 'internal'
    ) {
      return
    }
    if (
      getSessionMemoryTokensSinceUpdate() < config.memory.session.updateTokenThreshold
      || getSessionMemoryToolCallsSinceUpdate() < config.memory.session.updateToolCallThreshold
    ) {
      return
    }
    // Reset the accumulators now, synchronously, against `snapshot` — NOT in a
    // finally after the await. Mid-turn updates run non-blocking, so the agent
    // loop keeps producing messages (and bumping these counters) while the LLM
    // rewrite is in flight; a finally-reset would wipe that concurrent
    // accumulation and the next update would fire late. Resetting here leaves
    // exactly the post-snapshot work counted toward the next update.
    resetSessionMemoryCounters()

    const meta = await loadMeta(getSessionId())
    const since = meta?.sessionMemoryUpdatedAt ?? 0
    const newMessages = snapshot.filter(
      message => message.type !== 'system' && message.timestamp > since,
    )
    if (newMessages.length === 0) {
      return
    }

    try {
      const update: SessionMemoryUpdateInput = {
        sessionId: getSessionId(),
        sessionsDir: getSessionsDir(),
        newMessages,
        config,
      }
      const result = await sessionMemoryUpdaterImpl(update)
      if (result.updated) {
        // Watermark = the newest message actually summarized, NOT Date.now().
        // Mid-turn updates are non-blocking, so the loop produces more messages
        // during the rewrite window; a wall-clock watermark would jump past
        // them and the next update's `timestamp > since` filter would
        // permanently exclude every message created while this update ran.
        const ts = Math.max(...newMessages.map(message => message.timestamp))
        await updateMetaSessionMemoryAt(getSessionId(), ts)
        incrementSessionMemoryUpdateCount()
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[session-memory] ${message}`)
    }
  }

  // Mid-turn session-memory updates run non-blocking. A long turn crosses the
  // token + tool_call thresholds many times (a 31-min / 63-iteration dogfood
  // turn fired ~17 updates); awaiting each LLM rewrite inside the agent loop
  // adds that latency straight to wall-clock. Only one update is allowed in
  // flight at a time — while one runs, later tool boundaries skip and leave
  // the counters accumulating, so the next update naturally coalesces the work
  // done in between instead of queuing a call per boundary.
  let sessionMemoryInFlight: Promise<void> | null = null

  // Non-blocking: kick a session-memory update unless one is already running.
  // Used at mid-turn tool boundaries — fire-and-forget, errors logged.
  const kickSessionMemoryUpdate = (snapshot: Message[]): void => {
    if (sessionMemoryInFlight) {
      return
    }
    const pending = maybeUpdateSessionMemory(snapshot).catch(err => {
      const detail = err instanceof Error ? err.message : String(err)
      process.stderr.write(`[query] session-memory update failed: ${detail}\n`)
    })
    sessionMemoryInFlight = pending
    void pending.finally(() => {
      if (sessionMemoryInFlight === pending) {
        sessionMemoryInFlight = null
      }
    })
  }

  // Blocking: await any in-flight mid-turn update, then run a final update so
  // the on-disk session-memory.md is current before the query returns. Used at
  // end_turn. The final update is still threshold-gated, so a short turn that
  // never crossed the thresholds is a no-op here, same as before.
  const flushSessionMemoryUpdate = async (snapshot: Message[]): Promise<void> => {
    if (sessionMemoryInFlight) {
      await sessionMemoryInFlight
    }
    try {
      await maybeUpdateSessionMemory(snapshot)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      process.stderr.write(`[query] session-memory flush failed: ${detail}\n`)
    }
  }

  // Incremental transcript persistence. Hands the caller each coherent batch
  // of new messages as the turn produces them — at every tool-call boundary
  // (assistant + tool_result pair) and after the final end-turn assistant
  // message — so a crash mid-turn leaves a valid partial transcript on disk
  // instead of losing the whole turn. When a compaction rewrites the message
  // prefix the append cursor goes stale: the next flush resyncs the whole
  // transcript once through rewriteMessages, then incremental appends resume
  // from the compacted baseline (so a long turn that compacts mid-flight
  // stays durable). Best-effort: a persist / rewrite throw is caught and
  // logged, never surfaced to the turn.
  const flushTranscript = async (): Promise<void> => {
    if (!invocation.persistMessages) {
      return
    }
    if (compactionRewritePending) {
      // A compaction spliced the message prefix. Resync the on-disk
      // transcript to the compacted state, then resume incremental appends.
      compactionRewritePending = false
      if (!invocation.rewriteMessages) {
        // No resync channel — fall back to "stop flushing", the caller's
        // end-of-query rewrite is then the source of truth.
        transcriptFlushDisabled = true
        return
      }
      try {
        await invocation.rewriteMessages(messages)
        transcriptPersistCursor = messages.length
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        process.stderr.write(`[query] rewriteMessages failed: ${detail}\n`)
        transcriptFlushDisabled = true
      }
      return
    }
    if (transcriptFlushDisabled) {
      return
    }
    if (transcriptPersistCursor >= messages.length) {
      return
    }
    const batch = messages.slice(transcriptPersistCursor)
    try {
      await invocation.persistMessages(batch)
      // Advance the cursor only after a successful persist. persistMessages
      // writes the batch atomically (one appendFile), so a throw leaves
      // nothing on disk — keeping the cursor put means the next flush
      // re-sends the whole batch, neither duplicating nor leaving a gap.
      transcriptPersistCursor += batch.length
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      process.stderr.write(`[query] persistMessages failed: ${detail}\n`)
    }
  }

  const systemPromptTemplate = hasSystemPromptOverride
    ? null
    : await buildSystemPromptTemplate(params.tools, getCwd(), getRuntime().workspaceRoot, getRuntime().scratchRoot, {
        autoMemory: !invocation.noAutoMemory && config.memory.extractor.enabled,
        config,
        queryText: getLastUserText(messages),
        sessionId: getSessionId(),
      })

  const renderEffectiveSystemPrompt = (): string => {
    if (hasSystemPromptOverride) {
      return systemPromptOverride ?? ''
    }
    const sessionCtx = getCurrentSessionContext()
    const catalog = buildTurnToolCatalog({
      allTools: params.tools,
      discoveredTools: sessionCtx?.discoveredTools ?? new Map(),
      config,
    })
    const rendered = renderSystemPrompt(systemPromptTemplate!, getTodos(), {
      tools: catalog.tools,
      deferredTools: catalog.deferred,
      discoveredTools: sessionCtx?.discoveredTools,
      enabledSecrets: getCurrentEnabledSecrets(),
    })
    return invocation.channelContext
      ? `${invocation.channelContext}\n\n${rendered}`
      : rendered
  }

  let turnCatalog: TurnToolCatalog = {
    tools: params.tools,
    deferred: [],
    deferredEnabled: false,
    inlineTools: params.tools,
    discoveredCatalogTools: [],
  }

  const makeHookContext = (messagesSnapshot?: Message[]): HookContext => ({
    role: params.role,
    rolePolicy,
    config,
    invocation,
    messages,
    messagesSnapshot,
    allTools: params.tools,
    systemPrompt: {
      hasOverride: hasSystemPromptOverride,
      override: systemPromptOverride,
      template: systemPromptTemplate ?? undefined,
      renderEffective: renderEffectiveSystemPrompt,
    },
    get turnCatalog() {
      return turnCatalog
    },
    setTurnCatalog(catalog) {
      turnCatalog = catalog
    },
    mergeUsage(usage) {
      totalUsage = mergeUsage(totalUsage, usage)
    },
    markDidCompact() {
      didCompact = true
      // The next flushTranscript resyncs the on-disk transcript to the
      // compacted state, then incremental appends resume.
      compactionRewritePending = true
    },
    stopReason: () => stopReason,
  })

  const beforeQueryResult = await runHook('beforeQuery', {
    sessionId: getSessionId(),
    input: getLastUserText(messages),
    messageCount: messages.length,
  })
  if (beforeQueryResult?.replacementInput !== undefined) {
    replaceLastUserText(messages, beforeQueryResult.replacementInput)
  }
  if (beforeQueryResult?.abort) {
    await runHook('afterQuery', {
      sessionId: getSessionId(),
      usage: { input: 0, output: 0 },
      abortReason: beforeQueryResult.abort.reason,
      messageCount: messages.length,
    })
    return {
      messages,
      assistantText: '',
      finalReplyText: '',
      stopReason: 'hook_abort',
      didCompact,
      usage: totalUsage,
    }
  }

  const dispatchCtx: DispatchContext = {
    tools: params.tools,
    allTools: params.tools,
    deferredTools: [],
    roleKind: rolePolicy.kind,
    permissionApprover: invocation.permissionApprover,
    onToolResult: invocation.onToolResult,
    maxToolOutputBytes: config.tools.maxOutputBytes,
    config,
    canUseTool: invocation.canUseTool,
    chainState: invocation.chainState,
    signal,
  }

  type StopEvent = Extract<
    Awaited<ReturnType<typeof defaultStreamChat>> extends AsyncGenerator<infer T> ? T : never,
    { type: 'stop' }
  >

  for (let turn = 0; turn < maxTurns; turn += 1) {
    // Bail before starting a new turn if /stop aborted between turns.
    throwIfAborted(signal)
    // Pick up a mid-turn `/model` switch: slashDrain at the previous tool
    // boundary mutated config.defaultModel, so this turn streams under the
    // new model. No-op when nothing changed.
    roleModel = resolveRoleModel(params.role, config)
    let stopEvent: StopEvent | undefined
    turnCatalog = {
      tools: params.tools,
      deferred: [],
      deferredEnabled: false,
      inlineTools: params.tools,
      discoveredCatalogTools: [],
    }
    for (const hook of lifecycleHooks) {
      await hook.beforeTurn?.(makeHookContext())
    }
    dispatchCtx.tools = turnCatalog.tools
    dispatchCtx.allTools = params.tools
    dispatchCtx.deferredTools = turnCatalog.deferred

    // Stream the assistant turn. If the API rejects the request as
    // prompt-too-long (typical 400 from Anthropic when input exceeds
    // context), force a compact and retry once. Streaming text deltas are
    // not yielded until the request is accepted, so a retry does not
    // double-print to the user.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      stopEvent = undefined
      // Lazy-init: avoid eagerly calling renderEffectiveSystemPrompt() when a
      // beforeStream hook (split-render) is going to overwrite the result.
      // For orchestrator roles split-render always wins, so eager init meant
      // two full prompt renders + two catalog builds per attempt — wasted work
      // that doubles on prompt-too-long retry. Fall back to the default render
      // only when no beforeStream hook produces a RenderedPrompt (workers with
      // the default `hooks: ['prompt-too-long-retry']` policy hit this path).
      let renderedPrompt: RenderedPrompt | null = null
      for (const hook of lifecycleHooks) {
        const rendered = await hook.beforeStream?.(makeHookContext())
        if (rendered) {
          renderedPrompt = rendered
        }
      }
      if (!renderedPrompt) {
        renderedPrompt = {
          system: hasSystemPromptOverride
            ? (systemPromptOverride ?? '')
            : renderEffectiveSystemPrompt(),
        }
      }
      // Hoisted above the try block so the transient-retry catch can call
      // `mainRoute.provider.recycleConnections?.()` to force a fresh TCP
      // handshake on retry. Re-resolved each attempt because `/model`
      // mid-turn slash could swap the provider between attempts.
      const mainRoute = getProviderFor(config, roleModel)
      try {
        dispatchCtx.mainTurnRouting = {
          provider: mainRoute.provider,
          schema: mainRoute.provider.name,
          endpoint: mainRoute.entry.endpoint,
          endpointBaseUrl: config.endpoints[mainRoute.entry.endpoint]?.baseUrl,
          upstreamModel: mainRoute.entry.upstreamModel,
        }
        // TTFB observation — the wall-clock between calling streamChatImpl and
        // receiving the first stream event. Surfaces upstream-link slowness
        // (proxy / chatgpt backend queue) that otherwise reads as "daemon
        // hung" because the daemon is idle waiting on response bytes.
        // Grep: [ttfb] for per-call distribution; admin can compute percentiles.
        const streamStartMs = Date.now()
        const idleThresholds = streamIdleThresholds(config, mainRoute.provider)
        const streamAbort = new AbortController()
        const combinedSignal = AbortSignal.any([signal, streamAbort.signal])
        let lastEventAt = streamStartMs
        let ttfbLogged = false
        const idleTick = setInterval(() => {
          if (streamAbort.signal.aborted || signal.aborted) {
            return
          }
          const kind = ttfbLogged ? 'inter-event' : 'ttfb'
          const budget = kind === 'inter-event'
            ? idleThresholds.interEventMs
            : idleThresholds.ttfbMs
          const idleMs = Date.now() - lastEventAt
          if (idleMs <= budget) {
            return
          }
          const error = new IdleStreamError({
            kind,
            idleMs,
            model: roleModel,
            endpoint: mainRoute.entry.endpoint,
          })
          process.stderr.write(
            `[stream-idle-abort] sid=${getSessionId()} kind=${kind} ms=${idleMs} model=${roleModel} endpoint=${mainRoute.entry.endpoint}\n`,
          )
          streamAbort.abort(error)
          clearInterval(idleTick)
        }, streamIdleCheckIntervalMs)
        try {
          // The per-turn volatile suffix (TodoList + deferred-tools
          // reminder) used to ride the system prompt. On OpenAI Codex auto
          // prefix-cache, any byte change in `instructions` breaks every
          // subsequent token's cache hit — the entire `input` array
          // following lost cache too. Inject the suffix at the END of the
          // last user message instead, so the cache miss boundary aligns
          // with where it would have miss anyway (the fresh tool_result
          // block of this turn). The stable system prompt then stays
          // fully cacheable across turns. Provider-agnostic by design.
          // See `injectSystemReminderIntoLastUserMessage` for details.
          const wireMessages = renderedPrompt.systemVariableSuffix
            ? injectSystemReminderIntoLastUserMessage(
                toApiMessages(messages),
                renderedPrompt.systemVariableSuffix,
              )
            : toApiMessages(messages)
          for await (const event of streamChatImpl({
            config,
            model: roleModel,
            messages: wireMessages,
            system: renderedPrompt.system,
            tools: turnCatalog.tools.map(toolToAPISchema),
            // A compaction splices the message prefix, so the caller's
            // breakpoint index no longer points at the message it was derived
            // from. Drop it once compacted and let the provider auto-place the
            // prompt-cache breakpoint.
            cacheBreakpointMessageIndex: didCompact
              ? undefined
              : invocation.cacheBreakpointMessageIndex,
            signal: combinedSignal,
            ...(params.forceFallbackInToolResult
              ? { forceFallbackInToolResult: params.forceFallbackInToolResult }
              : {}),
            apiLogContext: {
              kind: apiLogKind,
              ...(apiLogKind === 'subagent' && invocation.subagentLabel
                ? { subagentLabel: invocation.subagentLabel }
                : {}),
              turn,
              attempt,
            },
          })) {
            lastEventAt = Date.now()
            if (!ttfbLogged) {
              ttfbLogged = true
              process.stderr.write(
                `[ttfb] sid=${getSessionId()} role=${params.role.agentType} model=${roleModel} endpoint=${mainRoute.entry.endpoint} kind=${apiLogKind} ms=${Date.now() - streamStartMs}\n`,
              )
            }
            if (event.type === 'keepalive') {
              continue
            }
            if (event.type === 'text') {
              invocation.onTextDelta?.(event.text)
              continue
            }

            if (event.type === 'tool_use') {
              invocation.onToolUse?.({ name: event.name, input: event.input })
              continue
            }

            stopEvent = event
          }
        } catch (error) {
          // Caller signal (`/stop`, interjection auto-abort) takes precedence
          // over the local idle watcher. Race: the watcher tick has a
          // millisecond-scale window where caller abort lands BETWEEN the
          // tick's own `signal.aborted` early-out and `streamAbort.abort()`,
          // so both end up aborted. Without this precedence, that race
          // re-throws IdleStreamError → `isTransientError(...) === true` →
          // retries a user-stopped turn against the user's explicit intent.
          // The classification is intentionally caller-first: if `/stop`
          // fired, propagate the original AbortError so `isAbortError`
          // catches it on the outer retry path and the turn ends honestly.
          if (signal.aborted) {
            throw error
          }
          const reason = streamAbort.signal.reason
          if (streamAbort.signal.aborted && reason instanceof IdleStreamError) {
            throw reason
          }
          throw error
        } finally {
          clearInterval(idleTick)
        }
        break
      } catch (error) {
        if (attempt === 0) {
          let shouldRetry = false
          for (const hook of lifecycleHooks) {
            const action = await hook.onStreamError?.(error, makeHookContext())
            if (action?.kind === 'retry') {
              shouldRetry = true
              break
            }
          }
          // Transient stream failure (connection drop, 5xx, 429, ...): retry
          // just this turn's streamChat. Retrying here — rather than letting
          // the error propagate to the channel runner's whole-query retry —
          // re-does only the failed API call, so the completed tool calls of
          // prior turns are not re-executed. Bounded by this loop's attempt
          // cap; a still-failing transient error then propagates to the
          // runner's own bounded retry as the last resort.
          if (!shouldRetry && isTransientError(error)) {
            const detail = error instanceof Error ? error.message : String(error)
            process.stderr.write(
              `[query] transient stream error on turn ${turn}; retrying turn: ${detail}\n`,
            )
            await new Promise(resolve => setTimeout(resolve, transientTurnRetryDelayMs))
            shouldRetry = true
          }
          if (shouldRetry) {
            // Force a fresh TCP connection on the retry attempt. The
            // transient class includes IdleStreamError (proxy / TLS
            // stalled with no bytes flowing); on retry the undici /
            // proxy keep-alive pool would otherwise route through the
            // very socket that just stalled, so retry without recycle
            // ≈ no retry at all (2026-05-25 dogfood: 30 ttfb aborts in
            // 30 min on the 1091 proxy's ~3% socket-stall rate).
            // Best-effort — provider may not implement the hook.
            try {
              mainRoute.provider.recycleConnections?.()
            } catch (recycleError) {
              process.stderr.write(
                `[query] recycleConnections threw on turn ${turn}: ${
                  recycleError instanceof Error ? recycleError.message : String(recycleError)
                }\n`,
              )
            }
            continue
          }
        }
        throw error
      }
    }

    if (!stopEvent) {
      throw new Error('Model stream ended without a stop event.')
    }

    addUsage(stopEvent.usage)
    totalUsage = mergeUsage(totalUsage, stopEvent.usage)
    void appendUsage({
      ts: new Date().toISOString(),
      user: getCurrentUserId() ?? '__terminal__',
      model: roleModel,
      kind: invocation.ephemeral ? 'fresh' : apiLogKind,
      input: stopEvent.usage.input_tokens ?? 0,
      output: stopEvent.usage.output_tokens ?? 0,
      cacheRead: stopEvent.usage.cache_read_input_tokens ?? 0,
      cacheCreate: stopEvent.usage.cache_creation_input_tokens ?? 0,
    })
    addSessionMemoryTokens(
      (stopEvent.usage.input_tokens ?? 0) + (stopEvent.usage.output_tokens ?? 0),
    )
    stopReason = stopEvent.stopReason
    // Skip empty turns (model often ends a turn with no text after a closing
    // tool_use's tool_result is processed). Accumulating only non-empty text
    // ensures the channel reply / Dispatch tool_result preserve everything
    // the model actually said, not just whatever the final turn happened to
    // emit.
    const turnText = collectAssistantText(stopEvent.content)
    const toolUses = stopEvent.content.filter(
      (block): block is ToolUseBlock => block.type === 'tool_use',
    )
    if (turnText.length > 0) {
      assistantTexts.push(turnText)
    }
    // A response that carries tool calls keeps the turn going — its text is
    // interim narration. One without ends the turn — its text is the reply.
    // Receivers route the two differently. A tool-bearing response fires the
    // callback even with EMPTY text: that is the earliest moment the turn is
    // known to be tool-using, and it is awaited BEFORE tool dispatch so a
    // receiver can anchor per-turn UI ahead of anything the tools emit.
    // An empty no-tool response stays silent (nothing to deliver).
    if (invocation.onAssistantTurn && (turnText.length > 0 || toolUses.length > 0)) {
      try {
        await invocation.onAssistantTurn(turnText, { isFinal: toolUses.length === 0 })
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        process.stderr.write(
          `[query] onAssistantTurn callback failed: ${detail}\n`,
        )
      }
    }
    const assistantMessage = createAssistantMessage({
      content: stopEvent.content,
      stopReason: stopEvent.stopReason,
      usage: stopEvent.usage,
      parentUuid: getLastUuid(messages),
    })
    messages.push(assistantMessage)


    // A turn that produced real output clears the empty-stop rescue guard, so
    // a later spurious empty stop can be rescued again (see the backstop in
    // the no-tool branch below).
    if (turnText.length > 0 || toolUses.length > 0) {
      pendingEmptyStopRescue = false
    }

    for (const hook of lifecycleHooks) {
      await hook.afterAssistantMessage?.(makeHookContext())
    }

    if (toolUses.length === 0) {
      // Persist the final end-turn assistant message before post-turn work
      // (session-memory, auto-compact) so a crash here still keeps the
      // model's answer on disk.
      await flushTranscript()
      // A write slash may have arrived during this final no-tool turn.
      // Apply it before the query returns so it does not have to wait for
      // the runner's post-query leftover-replay path.
      await invocation.slashDrain?.()
      // Phase 27 late-interjection rescue: if the user sent an interjection
      // *during* the LLM turn that just produced a final answer (no
      // tool_use), the tool-boundary drain in the finally block below
      // never ran for it. Without this rescue the queued entries are
      // silently dropped when the channel runner unmarks in-flight, and
      // the user sees "插嘴模式没生效" — visible in stderr as
      //   "interjection queued for session ... (size=N)"
      //   "query done"
      // with NO "query: injected" between them. Drain here, inject as a
      // standalone user message, and continue the loop so the LLM gets
      // another turn to react. Same `<user-interjection>` framing as the
      // tool-boundary path.
      const lateInterjections = (await invocation.interjectionDrain?.()) ?? []
      if (lateInterjections.length > 0) {
        const lateContent = renderInterjectionContent(
          invocation,
          lateInterjections,
          messages,
        )
        if (lateContent.length > 0) {
          const lateUserMessage = createUserMessage(lateContent, getLastUuid(messages))
          lateUserMessage.metadata = {
            ...(lateUserMessage.metadata ?? {}),
            interjectionEntries: lateInterjections.map(entry => ({
              messageId: entry.messageId,
              senderOpenId: entry.senderOpenId,
              arrivedAt: entry.arrivedAt,
              text: entry.text,
            })),
          }
          messages.push(lateUserMessage)
          await flushTranscript()
          process.stderr.write(
            `query: injected ${lateInterjections.length} late interjection${lateInterjections.length === 1 ? '' : 's'} after end_turn\n`,
          )
          // Loop back to send the new user message to the LLM.
          continue
        }
      }
      // Empty-stop backstop (dogfood 5/29 Bug 2). The model ended the turn with
      // no text and no tool call. An empty turn is never a finished state —
      // observed with gpt-codex-mid ending empty right after narrating "I'll
      // dispatch coder next" and marking the step in_progress (row 99 of the
      // 5/28 main-group transcript: stopReason end_turn, content []). Two
      // triggers rescue it: a todo still in_progress (the original case), OR a
      // dispatched worker (kind 'worker') whose final reply IS its delivery to
      // its requester — an empty one hands over nothing, with or without a todo.
      // The system-prompt reminders ask the model to keep going, but a turn that
      // emits zero tokens can't be steered by prompt text. Inject one neutral
      // continuation nudge and re-enter the loop so the model either takes the
      // next concrete step or, if it is genuinely blocked, surfaces the blocker
      // in real words. Runs only after the late-interjection rescue above (a
      // real user message, when present, revives the loop on its own and is
      // preferred). `pendingEmptyStopRescue` caps this at one nudge per
      // consecutive empty stop so a model that keeps returning empty cannot loop
      // forever.
      if (
        turnText.length === 0 &&
        !pendingEmptyStopRescue &&
        (rolePolicy.kind === 'worker' ||
          getTodos().some(todo => todo.status === 'in_progress'))
      ) {
        pendingEmptyStopRescue = true
        messages.push(
          createUserMessage(EMPTY_STOP_RESCUE_REMINDER, getLastUuid(messages)),
        )
        await flushTranscript()
        process.stderr.write(
          'query: empty end_turn with in_progress todo — injected continuation nudge\n',
        )
        continue
      }

      const extractionSnapshot = [...messages]
      if (!invocation.ephemeral) {
        // Fire-and-forget the end-turn session-memory flush: do NOT hold the
        // turn — and, on a channel, the in-flight marker that gates user
        // interjections — for a post-turn session-memory LLM write (observed
        // 40-60s on a reasoning sub-LLM). Mirrors Claude Code's
        // `void executePostSamplingHooks`. updateSessionMemory serializes per
        // session, so a flush that outlives this turn cannot race the next
        // turn's write. registerBackgroundTask keeps it drainable at shutdown.
        // Auto-compact (afterEndTurn) STAYS blocking below — the next turn
        // needs the compacted transcript (Claude Code awaits compaction too).
        registerBackgroundTask(flushSessionMemoryUpdate(extractionSnapshot))
        for (const hook of lifecycleHooks) {
          await hook.afterEndTurn?.(makeHookContext(extractionSnapshot), stopEvent.usage)
        }
      }
      const assistantText = assistantTexts.join('\n\n')
      await runHook('afterQuery', {
        sessionId: getSessionId(),
        finalText: assistantText,
        usage: {
          input: stopEvent.usage.input_tokens ?? 0,
          output: stopEvent.usage.output_tokens ?? 0,
        },
        messageCount: messages.length,
      })
      return {
        messages,
        assistantText,
        finalReplyText: assistantTexts.at(-1) ?? '',
        stopReason,
        didCompact,
        usage: totalUsage,
      }
    }

    // Dispatch tool_uses. Contiguous concurrencySafe tools run in a single
    // Promise.all batch; everything else runs serially. The try/finally
    // guarantees that for every tool_use block in the assistant message,
    // *some* tool_result is appended to the next user message — even if
    // dispatch is interrupted by an unhandled error or the abort signal.
    // Without this the message sequence becomes invalid (Anthropic 400) and
    // session resume breaks.
    const toolResults: UserToolResultBlock[] = []
    const completed = new Set<string>()
    try {
      let i = 0
      while (i < toolUses.length) {
        // On /stop, throw out of the loop; the finally below synthesizes
        // tool_results for every tool_use not yet completed.
        throwIfAborted(signal)
        const head = toolUses[i]
        const headTool = findToolByName(turnCatalog.tools, head.name)
        if (headTool?.concurrencySafe) {
          const batch: ToolUseBlock[] = []
          while (i < toolUses.length) {
            const tu = toolUses[i]
            const candidateTool = findToolByName(turnCatalog.tools, tu.name)
            if (!candidateTool?.concurrencySafe) {
              break
            }
            batch.push(tu)
            i += 1
          }
          const results = await Promise.all(
            batch.map(tu => dispatchToolCall(tu, dispatchCtx)),
          )
          for (let k = 0; k < batch.length; k += 1) {
            completed.add(batch[k].id)
            toolResults.push(results[k])
            addSessionMemoryToolCall()
          }
          throwIfAborted(signal)
        } else {
          const result = await dispatchToolCall(head, dispatchCtx)
          completed.add(head.id)
          toolResults.push(result)
          addSessionMemoryToolCall()
          i += 1
          throwIfAborted(signal)
        }
      }
    } finally {
      for (const tu of toolUses) {
        if (!completed.has(tu.id)) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: 'Tool execution was aborted before completion.',
            is_error: true,
          })
        }
      }
      // Apply write slashes (/mode, /model, /rules allow, ...) queued
      // mid-turn before draining interjections, so a mode / model switch is
      // already in effect for the turn the drained interjections start.
      await invocation.slashDrain?.()
      const interjections = (await invocation.interjectionDrain?.()) ?? []
      const content: UserContentBlock[] = [...toolResults]
      if (interjections.length > 0) {
        content.push(...renderInterjectionContent(invocation, interjections, messages))
        process.stderr.write(
          `query: injected ${interjections.length} interjection${interjections.length === 1 ? '' : 's'} into next user message\n`,
        )
      }
      for (const hook of lifecycleHooks) {
        const extraContent = await hook.atToolBoundary?.(makeHookContext())
        if (extraContent?.length) {
          content.push(...extraContent)
        }
      }
      const nextUserMessage = createUserMessage(content, getLastUuid(messages))
      if (interjections.length > 0) {
        nextUserMessage.metadata = {
          ...(nextUserMessage.metadata ?? {}),
          interjectionEntries: interjections.map(entry => ({
            messageId: entry.messageId,
            senderOpenId: entry.senderOpenId,
            arrivedAt: entry.arrivedAt,
            text: entry.text,
          })),
        }
      }
      messages.push(nextUserMessage)
      // Persist this completed tool round-trip (assistant + tool_result user
      // message) before post-turn work so a crash keeps it on disk. Inside
      // the finally so an aborted dispatch still flushes the partial turn.
      await flushTranscript()
    }

    // After /stop, skip post-turn work (session-memory update, auto-compact /
    // auto-extract afterEndTurn hooks) for the turn the user just aborted.
    throwIfAborted(signal)
    if (!invocation.ephemeral) {
      kickSessionMemoryUpdate([...messages])
      for (const hook of lifecycleHooks) {
        await hook.afterEndTurn?.(makeHookContext(), stopEvent.usage)
      }
    }
  }

  throw new Error(`Exceeded maximum tool turns (${maxTurns}).`)
  }  // end queryInner
}

function modelSetupRequiredReply(
  role: Role,
  config: LightClawConfig,
  roleModel: string,
  currentUserId: string | undefined,
): string | null {
  if (role.agentType !== 'main' || !currentUserId) {
    return null
  }
  const entry = roleModel ? config.models[roleModel] : undefined
  if (entry) {
    return null
  }
  return formatModelSetupRequiredReply()
}

function getLastUserText(messages: Message[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.type === 'user' && typeof message.message.content === 'string') {
      return message.message.content
    }
  }

  return ''
}

function replaceLastUserText(messages: Message[], next: string): void {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.type === 'user' && typeof message.message.content === 'string') {
      message.message.content = next
      return
    }
  }
}
