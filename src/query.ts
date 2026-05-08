import type { Interface } from 'node:readline/promises'

import { getConfig, type LightClawConfig } from './config.js'
import { streamChat } from './api.js'
import {
  createCacheSafeParams,
  saveCacheSafeParams,
} from './agents/cache-safe-params.js'
import { runHook } from './hooks/index.js'
import { executeAutoDream } from './memory/dream/dream.js'
import { extractMemories, flushBeforeCompact } from './memory/extract.js'
import {
  updateSessionMemory,
  type SessionMemoryUpdateInput,
} from './memory/session-memory.js'
import {
  collectAssistantText,
  createAssistantMessage,
  createUserMessage,
  getLastUuid,
  toApiMessages,
} from './messages.js'
import { buildSystemPromptTemplate, renderSystemPrompt } from './prompt.js'
import { modelFor } from './provider/index.js'
import { requestPermission } from './permission/index.js'
import type { PermissionApprover } from './permission/types.js'
import {
  addSessionMemoryToolCall,
  addSessionMemoryTokens,
  addUsage,
  getAbortController,
  getCurrentUserId,
  getCwd,
  getLastExtractedAt,
  getMemoryDir,
  getRuntime,
  getSessionId,
  getSessionMemoryToolCallsSinceUpdate,
  getSessionMemoryTokensSinceUpdate,
  getTodos,
  incrementCompactionCount,
  incrementSessionMemoryUpdateCount,
  registerBackgroundTask,
  resetSessionMemoryCounters,
  setLastExtractedAt,
} from './state.js'
import { compactConversation } from './session/compact.js'
import { compactFallbackTruncate } from './session/compact-fallback.js'
import { maybeIdleMicroCompact } from './session/idle-mc.js'
import { maybeSummarizeToolResult } from './session/tool-summarize.js'
import {
  loadMeta,
  updateMetaLastExtractedAt,
  updateMetaSessionMemoryAt,
} from './session/storage.js'
import { getCurrentSessionContext } from './session-context.js'
import { appendUsage } from './usage/storage.js'
import { openApiLogger, runWithApiLogger } from './api-logs/storage.js'
import {
  findToolByName,
  toolToAPISchema,
  type CanUseToolFn,
  type Tool,
} from './tool.js'
import { estimateMessagesTokens } from './token-estimate.js'
import type {
  AssistantContentBlock,
  Message,
  ToolExecutionEvent,
  UsageStats,
  UserToolResultBlock,
} from './types.js'
import type { WakeNotifyResult } from './background-task/types.js'

/**
 * QueryMode selects orchestration behavior that differs between the REPL
 * (interactive), AgentTool subagents (subagent), and channel daemons like
 * feishu (channel). It drives whether auto-compact / auto-memory run and
 * whether the permission layer may invoke an interactive REPL prompt.
 *
 * | mode        | autoCompact | autoMemory | REPL prompt |
 * |-------------|:-----------:|:----------:|:-----------:|
 * | interactive |      ✓      |     ✓      |  ✓ (if rl)  |
 * | subagent    |      ✗      |     ✗      |      ✗      |
 * | channel     |      ✓      |     ✓      |      ✗      |
 */
export type QueryMode = 'interactive' | 'subagent' | 'channel'

type QueryParams = {
  messages: Message[]
  tools: Tool[]
  config?: LightClawConfig
  maxTurns?: number
  onTextDelta?(text: string): void
  onToolUse?(event: { name: string; input: Record<string, unknown> }): void
  onToolResult?(event: ToolExecutionEvent): void
  /**
   * Fires once per assistant turn that emitted a non-empty text body, with
   * the turn's full text. Channels (notably feishu) use this to deliver
   * intermediate narration progressively — the model often drops a long
   * research output mid-loop alongside a closing tool_use rather than at
   * the very end of the query, and waiting for end-of-query to send a
   * single reply leaves the user staring at silence for minutes. Fires
   * before tool dispatch for the same turn, so the receiver can surface
   * model intent before the next round of tool calls runs.
   *
   * Empty turns are skipped (no callback invocation). Failures are
   * caught + logged so a flaky channel send never aborts the agent loop.
   */
  onAssistantTurn?(text: string): Promise<void> | void
  onCompactStart?(): void
  onCompactEnd?(result: { removedCount: number; summaryTokens: number }): void
  onCompactError?(message: string): void
  /** Defaults to 'interactive'. */
  mode?: QueryMode
  rl?: Interface
  /** Replaces the default system prompt entirely (used by subagents). */
  systemPrompt?: string
  /** Prepended to the default system prompt when provided (used by channels). */
  channelContext?: string
  /** Async permission UI for non-REPL channels such as Feishu cards. */
  permissionApprover?: PermissionApprover
  /** Function-based tool gate used by forked agents before permission policy. */
  canUseTool?: CanUseToolFn
  /** Message index to mark as the fork prefix cache breakpoint. */
  cacheBreakpointMessageIndex?: number
  signal?: AbortSignal
  /**
   * Skip auto-memory recall + memory index injection. Used by /fresh so the
   * ephemeral one-shot session starts with a clean slate.
   */
  noAutoMemory?: boolean
  /**
   * Skip auto-compact + auto-extract + session-memory updates. Used by /fresh
   * since there's no persisted transcript for those subsystems to reason about.
   */
  ephemeral?: boolean
  /**
   * Forked-agent label propagated to api logs (`subagentLabel` field). Set by
   * runForkedAgent when mode === 'subagent'; ignored otherwise.
   */
  subagentLabel?: string
  wakeNotifications?: WakeNotifyResult[]
}

type ToolUseBlock = Extract<AssistantContentBlock, { type: 'tool_use' }>

type DispatchContext = {
  tools: Tool[]
  mode: QueryMode
  rl?: Interface
  permissionApprover?: PermissionApprover
  onToolResult?(event: ToolExecutionEvent): void
  maxToolOutputBytes: number
  config: LightClawConfig
  canUseTool?: CanUseToolFn
  signal: AbortSignal
  wakeNotifications?: WakeNotifyResult[]
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

function snipContent(content: string, maxBytes: number): string {
  const total = Buffer.byteLength(content, 'utf8')
  if (total <= maxBytes) {
    return content
  }
  const marker = `\n\n... [snipped ${total - maxBytes} bytes from middle of ${total} total] ...\n\n`
  const markerBytes = Buffer.byteLength(marker, 'utf8')
  const usable = Math.max(0, maxBytes - markerBytes)
  if (usable === 0) {
    return marker.trim()
  }
  const head = Math.floor(usable / 2)
  const tail = usable - head
  const buf = Buffer.from(content, 'utf8')
  return `${buf.subarray(0, head).toString('utf8')}${marker}${buf.subarray(buf.length - tail).toString('utf8')}`
}

function isPromptTooLongError(err: unknown): boolean {
  if (!err) {
    return false
  }
  const message = err instanceof Error ? err.message : String(err)
  const lower = message.toLowerCase()
  return (
    lower.includes('prompt is too long')
    || lower.includes('input is too long')
    || lower.includes('input length')
    || lower.includes('context length')
    || lower.includes('exceeds maximum context')
    || lower.includes('maximum context length')
  )
}

export async function query(params: QueryParams): Promise<{
  messages: Message[]
  /**
   * Accumulated non-empty text from every assistant turn in this query loop,
   * joined with double-newlines. The model often delivers its real reply in
   * a turn that *also* emits a tool_use (e.g. final research output + a
   * closing TodoWrite to mark done), then ends turn empty after the
   * tool_result. Channels that send a single reply at end-of-query (feishu)
   * and AgentTool callers that bundle the subagent's response into a parent
   * tool_result both want to see *all* of the model's narration, not just
   * the literal last turn — otherwise the closing empty end_turn produces
   * "(no response)" while the long body block-above gets dropped.
   */
  assistantText: string
  stopReason: string | null
  didCompact: boolean
  usage: UsageStats
}> {
  const config = params.config ?? getConfig()
  // Mirror Claude Code CLI: no default cap on tool-use turns; loop runs until
  // the model emits end_turn (or until abort / context exhaustion). Callers
  // that need a hard ceiling pass it explicitly (e.g. memory extraction);
  // operators can opt into a global ceiling via config.maxTurns.
  const maxTurns =
    params.maxTurns ?? config.maxTurns ?? Number.POSITIVE_INFINITY
  const mode: QueryMode = params.mode ?? 'interactive'
  const messages = [...params.messages]
  const assistantTexts: string[] = []
  let stopReason: string | null = null
  let didCompact = false
  let totalUsage: UsageStats = {}

  // Open per-query API logger and push it on the AsyncLocalStorage scope so
  // every nested streamChat call (main loop turns + recall + session-memory
  // + compact + tool-summarize, plus subagent forks that open their own
  // nested logger) writes into this query's file. No-op when
  // config.apiLogs.enabled is false (the default).
  const apiLogger = openApiLogger({
    enabled: config.apiLogs.enabled,
    dir: config.apiLogs.dir,
    sessionId: getSessionId(),
  })
  return runWithApiLogger(apiLogger, () => queryInner())

  async function queryInner(): Promise<{
    messages: Message[]
    assistantText: string
    stopReason: string | null
    didCompact: boolean
    usage: UsageStats
  }> {

  // P1: SessionMemory write triggered post-turn when both token and tool_call
  // accumulators cross their thresholds. Synchronous so the next prompt build
  // sees the freshly written file. Failures are logged, never raised.
  const maybeUpdateSessionMemory = async (snapshot: Message[]): Promise<void> => {
    if (
      mode === 'subagent'
      || !config.autoMemory
      || !config.sessionMemory.enabled
    ) {
      return
    }
    if (
      getSessionMemoryTokensSinceUpdate() < config.sessionMemory.updateTokenThreshold
      || getSessionMemoryToolCallsSinceUpdate() < config.sessionMemory.updateToolCallThreshold
    ) {
      return
    }

    const meta = await loadMeta(getSessionId())
    const since = meta?.sessionMemoryUpdatedAt ?? 0
    const newMessages = snapshot.filter(
      message => message.type !== 'system' && message.timestamp > since,
    )
    if (newMessages.length === 0) {
      // Nothing new to summarize but counters crossed — reset so we do not
      // hammer the model on every subsequent turn.
      resetSessionMemoryCounters()
      return
    }

    try {
      const update: SessionMemoryUpdateInput = {
        sessionId: getSessionId(),
        sessionsDir: config.sessionsDir,
        newMessages,
        config,
      }
      const result = await updateSessionMemory(update)
      if (result.updated) {
        const ts = Date.now()
        await updateMetaSessionMemoryAt(getSessionId(), ts)
        incrementSessionMemoryUpdateCount()
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[session-memory] ${message}`)
    } finally {
      resetSessionMemoryCounters()
    }
  }

  const scheduleMemoryExtraction = (snapshot: Message[]) => {
    if (mode === 'subagent' || !config.autoMemory || stopReason !== 'end_turn') {
      return
    }

    const lastExtractedAt = getLastExtractedAt()
    const task = extractMemories({
      messages: snapshot,
      lastExtractedAt,
      memoryDir: getMemoryDir(),
      config,
    })
      .then(async result => {
        if (result.lastExtractedAt <= lastExtractedAt) {
          return
        }

        setLastExtractedAt(result.lastExtractedAt)
        await updateMetaLastExtractedAt(getSessionId(), result.lastExtractedAt)
      })
      .catch(error => {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[memory] ${message}`)
      })

    registerBackgroundTask(task)
  }

  const scheduleAutoDream = () => {
    if (
      mode === 'subagent' ||
      stopReason !== 'end_turn' ||
      !config.autoMemory ||
      !config.autoDream.enabled
    ) {
      return
    }

    const userId = getCurrentUserId()
    if (!userId) {
      return
    }

    const task = executeAutoDream({
      userId,
      memoryDir: getMemoryDir(),
      config,
      currentSessionId: getSessionId(),
    }).catch(error => {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[auto-dream] ${message}`)
    })

    registerBackgroundTask(task)
  }

  /**
   * Run conversation compaction and splice the result into `messages` in
   * place. When `force=false`, only runs if estimated tokens exceed the
   * configured threshold. When `force=true`, runs unconditionally — used
   * by the prompt-too-long reactive recovery path. Returns true iff
   * messages were actually replaced.
   */
  const runCompaction = async (force: boolean): Promise<boolean> => {
    if (mode === 'subagent' || !config.autoCompact) {
      return false
    }

    if (!force) {
      const totalTokens = estimateMessagesTokens(messages)
      const threshold = config.contextWindow * config.compactThresholdRatio
      if (totalTokens <= threshold) {
        return false
      }
    }

    // P2: pre-compact flush — persist hard facts to auto-memory before the
    // summarizer collapses the prefix. Failures are logged inside
    // flushBeforeCompact and never abort compaction.
    if (config.autoMemory && config.preCompactFlush.enabled) {
      const flushed = await flushBeforeCompact({
        messages: [...messages],
        lastExtractedAt: getLastExtractedAt(),
        memoryDir: getMemoryDir(),
        config,
        timeoutMs: config.preCompactFlush.timeoutMs,
      })
      if (flushed.lastExtractedAt > getLastExtractedAt()) {
        setLastExtractedAt(flushed.lastExtractedAt)
        await updateMetaLastExtractedAt(getSessionId(), flushed.lastExtractedAt)
      }
    }

    params.onCompactStart?.()
    try {
      const result = await compactConversation({
        messages,
        keepRecent: config.compactKeepRecent,
        config,
        sessionId: getSessionId(),
      })

      if (result.removedCount === 0) {
        return false
      }

      messages.splice(0, messages.length, ...result.messages)
      addUsage(result.usage)
      totalUsage = mergeUsage(totalUsage, result.usage)
      incrementCompactionCount()
      didCompact = true
      params.onCompactEnd?.({
        removedCount: result.removedCount,
        summaryTokens: result.summaryTokens,
      })
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // Always log: proactive compaction failures used to be completely
      // silent, so a session could quietly accumulate context until the
      // next turn 400s. One stderr line per failure lets admin grep.
      process.stderr.write(`[compact] LLM compaction failed (force=${force}): ${message}\n`)
      params.onCompactError?.(message)

      // Reactive recovery only: the caller (prompt-too-long handler) has
      // nowhere else to go if we return false here. Fall back to a hard
      // truncation so the user is never stuck on "compact failed".
      // Background passes (force=false) skip this — the next turn's
      // proactive compact has another shot.
      if (force) {
        const fallback = compactFallbackTruncate(messages, {
          keepRecent: Math.max(2, config.compactKeepRecent * 2),
          reason: message,
        })
        if (fallback.removedCount > 0) {
          messages.splice(0, messages.length, ...fallback.messages)
          incrementCompactionCount()
          didCompact = true
          process.stderr.write(
            `[compact] hard-truncate fallback elided ${fallback.removedCount} messages after LLM failure\n`,
          )
          params.onCompactEnd?.({
            removedCount: fallback.removedCount,
            summaryTokens: 0,
          })
          return true
        }
      }
      return false
    }
  }

  const systemPromptTemplate = params.systemPrompt
    ? null
    : await buildSystemPromptTemplate(params.tools, getCwd(), getRuntime().workspaceRoot, {
        autoMemory: !params.noAutoMemory && config.autoMemory,
        config,
        queryText: getLastUserText(messages),
        sessionId: getSessionId(),
      })

  const renderEffectiveSystemPrompt = (): string => {
    if (params.systemPrompt) {
      return params.systemPrompt
    }
    const rendered = renderSystemPrompt(systemPromptTemplate!, getTodos())
    return params.channelContext
      ? `${params.channelContext}\n\n${rendered}`
      : rendered
  }

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
      stopReason: 'hook_abort',
      didCompact,
      usage: totalUsage,
    }
  }

  const dispatchCtx: DispatchContext = {
    tools: params.tools,
    mode,
    rl: params.rl,
    permissionApprover: params.permissionApprover,
    onToolResult: params.onToolResult,
    maxToolOutputBytes: config.maxToolOutputBytes,
    config,
    canUseTool: params.canUseTool,
    signal: params.signal ?? getAbortController().signal,
    wakeNotifications: params.wakeNotifications,
  }

  type StopEvent = Extract<
    Awaited<ReturnType<typeof streamChat>> extends AsyncGenerator<infer T> ? T : never,
    { type: 'stop' }
  >

  for (let turn = 0; turn < maxTurns; turn += 1) {
    // Iter 3: idle MC. Clear stale tool_results before sending this turn's
    // request, so the shrunk prompt is what actually goes out. Idempotent on
    // re-run. Subagent mode is excluded — short lifetimes never reach the
    // gap threshold and there is no point spending a transcript rewrite on
    // them.
    if (mode !== 'subagent') {
      try {
        const mc = await maybeIdleMicroCompact(messages, config)
        if (mc.cleared > 0) {
          console.log(
            `[micro-compact:idle] cleared ${mc.cleared} tool_result(s), `
            + `~${mc.tokensSaved} tokens saved `
            + `(gap > ${config.microCompact.idle.gapThresholdMinutes}min, `
            + `kept last ${config.microCompact.idle.keepRecent})`,
          )
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[micro-compact:idle] failed: ${msg}`)
      }
    }

    let stopEvent: StopEvent | undefined

    // Stream the assistant turn. If the API rejects the request as
    // prompt-too-long (typical 400 from Anthropic when input exceeds
    // context), force a compact and retry once. Streaming text deltas are
    // not yielded until the request is accepted, so a retry does not
    // double-print to the user.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      stopEvent = undefined
      const systemPrompt = renderEffectiveSystemPrompt()
      try {
        for await (const event of streamChat({
          config,
          model: modelFor('main', config),
          messages: toApiMessages(messages),
          system: systemPrompt,
          tools: params.tools.map(toolToAPISchema),
          cacheBreakpointMessageIndex: params.cacheBreakpointMessageIndex,
          signal: params.signal ?? getAbortController().signal,
          apiLogContext: {
            kind: mode === 'subagent' ? 'subagent' : 'main',
            ...(mode === 'subagent' && params.subagentLabel
              ? { subagentLabel: params.subagentLabel }
              : {}),
            turn,
            attempt,
          },
        })) {
          if (event.type === 'text') {
            params.onTextDelta?.(event.text)
            continue
          }

          if (event.type === 'tool_use') {
            params.onToolUse?.({ name: event.name, input: event.input })
            continue
          }

          stopEvent = event
        }
        break
      } catch (error) {
        if (attempt === 0 && isPromptTooLongError(error)) {
          const compacted = await runCompaction(true)
          if (compacted) {
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
      model: config.model,
      kind: params.ephemeral ? 'fresh' : (mode === 'subagent' ? 'subagent' : 'main'),
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
    // ensures the channel reply / AgentTool tool_result preserve everything
    // the model actually said, not just whatever the final turn happened to
    // emit.
    const turnText = collectAssistantText(stopEvent.content)
    if (turnText.length > 0) {
      assistantTexts.push(turnText)
      if (params.onAssistantTurn) {
        try {
          await params.onAssistantTurn(turnText)
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          process.stderr.write(
            `[query] onAssistantTurn callback failed: ${detail}\n`,
          )
        }
      }
    }
    const assistantMessage = createAssistantMessage({
      content: stopEvent.content,
      stopReason: stopEvent.stopReason,
      usage: stopEvent.usage,
      parentUuid: getLastUuid(messages),
    })
    messages.push(assistantMessage)

    const toolUses = stopEvent.content.filter(
      (block): block is ToolUseBlock => block.type === 'tool_use',
    )

    // Snapshot cacheSafeParams unconditionally after every assistant push —
    // forks (AgentTool / memory extraction) read forkContextMessages and
    // synthesize placeholder tool_results for any pending tool_use blocks at
    // construction time (see runForkedAgent), so a "dirty" snapshot ending
    // in an assistant turn with pending tool_uses is fine. Always snapshotting
    // keeps the parent prefix (history bytes) cache-aligned across all forks
    // dispatched in the same turn.
    if (mode !== 'subagent') {
      saveCacheSafeParams(
        createCacheSafeParams({
          systemPrompt: renderEffectiveSystemPrompt(),
          tools: params.tools,
          messages: [...messages],
          config,
        }),
      )
    }

    if (toolUses.length === 0) {
      const extractionSnapshot = [...messages]
      if (!params.ephemeral) {
        await maybeUpdateSessionMemory(extractionSnapshot)
        await runCompaction(false)
        scheduleMemoryExtraction(extractionSnapshot)
        scheduleAutoDream()
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
        const head = toolUses[i]
        const headTool = findToolByName(params.tools, head.name)
        if (headTool?.concurrencySafe) {
          const batch: ToolUseBlock[] = []
          while (i < toolUses.length) {
            const tu = toolUses[i]
            const candidateTool = findToolByName(params.tools, tu.name)
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
        } else {
          const result = await dispatchToolCall(head, dispatchCtx)
          completed.add(head.id)
          toolResults.push(result)
          addSessionMemoryToolCall()
          i += 1
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
      messages.push(createUserMessage(toolResults, getLastUuid(messages)))
    }

    if (!params.ephemeral) {
      await maybeUpdateSessionMemory([...messages])
      await runCompaction(false)
    }
  }

  throw new Error(`Exceeded maximum tool turns (${maxTurns}).`)
  }  // end queryInner
}

async function dispatchToolCall(
  toolUse: ToolUseBlock,
  ctx: DispatchContext,
): Promise<UserToolResultBlock> {
  const tool = findToolByName(ctx.tools, toolUse.name)
  if (!tool) {
    return reportToolResult(ctx, toolUse, `Unknown tool: ${toolUse.name}`, true)
  }

  const parsedInput = parseToolInput(tool, toolUse.input)
  if (!parsedInput.ok) {
    return reportToolResult(
      ctx,
      toolUse,
      `Invalid input for ${toolUse.name}: ${parsedInput.error}`,
      true,
    )
  }

  let effectiveInput = parsedInput.data
  const callId = toolUse.id

  try {
    const hookDecision = await runHook('beforeToolCall', {
      sessionId: getSessionId(),
      callId,
      toolName: tool.name,
      source: tool.source,
      mcpServer: tool.mcpServer,
      input: effectiveInput,
    })

    if (hookDecision?.replacementInput !== undefined) {
      effectiveInput = hookDecision.replacementInput
    }

    // decision: 'deny' takes precedence over replacementResult.
    // A deny + replacementResult combination is treated as deny (is_error: true)
    // so a hook cannot silently convert a deny into a non-error result.
    if (hookDecision?.decision === 'deny') {
      const content = hookDecision.reason ?? `Tool denied by hook: ${tool.name}`
      return reportToolResult(ctx, toolUse, content, true)
    }

    if (hookDecision?.replacementResult !== undefined) {
      return reportToolResult(ctx, toolUse, hookDecision.replacementResult, false)
    }

    if (ctx.canUseTool) {
      const gate = await ctx.canUseTool(tool, effectiveInput)
      if (gate.behavior === 'deny') {
        return reportToolResult(ctx, toolUse, gate.reason, true)
      }
    }

    const sessionCtx = getCurrentSessionContext()
    const decision = await requestPermission({
      tool,
      toolInput: effectiveInput,
      ctx: {
        isInteractive: ctx.mode === 'interactive' && ctx.rl !== undefined,
        isSubagent: ctx.mode === 'subagent',
        signal: ctx.signal,
        permissionApprover: ctx.permissionApprover,
        isBackgroundTask: sessionCtx?.isBackgroundTask,
        taskAllowedTools: sessionCtx?.taskAllowedTools,
        onPermissionDenial: sessionCtx?.onPermissionDenial,
      },
      rl: ctx.rl,
    })

    if (decision.behavior === 'deny') {
      return reportToolResult(ctx, toolUse, decision.reason, true)
    }

    if (tool.domain === 'environment') {
      const runtime = getRuntime()
      const availability = await runtime.isAvailable()
      if (!availability.ok) {
        return reportToolResult(ctx, toolUse, availability.userMessage, true)
      }
    }

    const start = Date.now()
    const result = await tool.call(effectiveInput, {
      cwd: getCwd(),
      abortSignal: ctx.signal,
      runtime: getRuntime(),
      canUseTool: ctx.canUseTool,
      wakeNotifications: ctx.wakeNotifications,
    })
    const formatted = tool.formatResult(result.output, toolUse.id, result.isError)

    const afterTool = await runHook('afterToolCall', {
      sessionId: getSessionId(),
      callId,
      toolName: tool.name,
      source: tool.source,
      mcpServer: tool.mcpServer,
      input: effectiveInput,
      result: formatted.content,
      durationMs: Date.now() - start,
      ...(formatted.is_error ? { error: formatted.content } : {}),
    })
    if (afterTool?.replacementResult !== undefined) {
      formatted.content = afterTool.replacementResult
    }

    formatted.content = snipContent(formatted.content, ctx.maxToolOutputBytes)

    // Iter 2: per-tool LLM summarize. Runs after snipContent so very large
    // outputs are byte-capped first. Subagent gating is caller-driven via
    // `enabled`. Failures fall back to the snipped content via passthrough.
    const summarizeResult = await maybeSummarizeToolResult({
      toolName: tool.name,
      content: formatted.content,
      callId,
      isError: Boolean(formatted.is_error),
      signal: ctx.signal,
      config: ctx.config,
      enabled: ctx.mode !== 'subagent',
    })
    formatted.content = summarizeResult.output
    if (summarizeResult.summarized) {
      console.log(
        `[micro-compact:per-tool] ${tool.name} ${callId} `
        + `${summarizeResult.origTokens}→${summarizeResult.newTokens} tokens`,
      )
    }

    ctx.onToolResult?.({
      toolName: toolUse.name,
      isError: Boolean(formatted.is_error),
      content: formatted.content,
    })
    return formatted
  } catch (error) {
    const content = error instanceof Error ? error.message : String(error)
    await runHook('afterToolCall', {
      sessionId: getSessionId(),
      callId,
      toolName: tool.name,
      source: tool.source,
      mcpServer: tool.mcpServer,
      input: effectiveInput,
      result: content,
      durationMs: 0,
      error: content,
    })
    return reportToolResult(ctx, toolUse, content, true)
  }
}

function reportToolResult(
  ctx: DispatchContext,
  toolUse: ToolUseBlock,
  content: string,
  isError: boolean,
): UserToolResultBlock {
  const snipped = snipContent(content, ctx.maxToolOutputBytes)
  ctx.onToolResult?.({
    toolName: toolUse.name,
    isError,
    content: snipped,
  })
  return {
    type: 'tool_result',
    tool_use_id: toolUse.id,
    content: snipped,
    ...(isError ? { is_error: true } : {}),
  }
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

function parseToolInput(
  tool: Tool,
  rawInput: Record<string, unknown>,
): { ok: true; data: unknown } | { ok: false; error: string } {
  if (tool.source === 'mcp') {
    return { ok: true, data: rawInput }
  }

  if (!tool.inputSchema) {
    return { ok: false, error: 'Tool has no input schema.' }
  }

  const parsed = tool.inputSchema.safeParse(rawInput)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.message }
  }

  return { ok: true, data: parsed.data }
}
