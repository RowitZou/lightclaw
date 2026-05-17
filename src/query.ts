
import { getConfig, type LightClawConfig } from './config.js'
import { streamChat } from './api.js'
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
import { getProviderFor } from './provider/index.js'
import {
  resolveRoleMaxTurns,
  resolveRoleModel,
} from './model-resolution.js'
import {
  addSessionMemoryToolCall,
  addSessionMemoryTokens,
  addUsage,
  getAbortController,
  getCurrentUserId,
  getCwd,
  getRuntime,
  getSessionId,
  getSessionMemoryToolCallsSinceUpdate,
  getSessionMemoryTokensSinceUpdate,
  getTodos,
  incrementSessionMemoryUpdateCount,
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

type QueryParams = {
  role: Role
  invocation: InvocationContext
  messages: Message[]
  tools: Tool[]
  config?: LightClawConfig
  maxTurns?: number
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
  const invocation = params.invocation ?? emptyInvocationContext()
  const rolePolicy = resolveRolePolicy(params.role)
  const roleModel = resolveRoleModel(params.role, config)
  const currentSessionContext = getCurrentSessionContext()
  if (currentSessionContext) {
    currentSessionContext.currentRole = invocation.currentRoleOverride ?? params.role
  }
  const contextPolicy = rolePolicy.contextPolicy
  const lifecycleHooks = resolveHooks(params.role)
  const systemPromptOverride = invocation.systemPromptOverride
  const hasSystemPromptOverride = systemPromptOverride !== undefined
  const signal = invocation.signal ?? getAbortController().signal
  const apiLogKind = rolePolicy.kind === 'orchestrator' ? 'main' : 'subagent'
  // Mirror Claude Code CLI: no default cap on tool-use turns; loop runs until
  // the model emits end_turn (or until abort / context exhaustion). Callers
  // that need a hard ceiling pass it explicitly (e.g. memory extraction);
  // operators can opt into a global ceiling via config.maxTurns.
  const maxTurns =
    params.maxTurns
    ?? resolveRoleMaxTurns(params.role, config)
    ?? config.maxTurns
    ?? Number.POSITIVE_INFINITY
  const messages = [...params.messages]
  const assistantTexts: string[] = []
  let stopReason: string | null = null
  let didCompact = false
  let totalUsage: UsageStats = {}

  // Open per-query API logger and push it on the AsyncLocalStorage scope so
  // every nested streamChat call (main loop turns + recall + session-memory
  // + compact, plus subagent forks that open their own nested logger) writes
  // into this query's file. No-op when config.apiLogs.enabled is false (the
  // default).
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
      !contextPolicy.sessionWorkingMemory
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

  const systemPromptTemplate = hasSystemPromptOverride
    ? null
    : await buildSystemPromptTemplate(params.tools, getCwd(), getRuntime().workspaceRoot, {
        autoMemory: !invocation.noAutoMemory && config.autoMemory,
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
    })
    return invocation.channelContext
      ? `${invocation.channelContext}\n\n${rendered}`
      : rendered
  }

  let turnCatalog: TurnToolCatalog = {
    tools: params.tools,
    deferred: [],
    deferredEnabled: false,
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
    maxToolOutputBytes: config.maxToolOutputBytes,
    config,
    canUseTool: invocation.canUseTool,
    signal,
  }

  type StopEvent = Extract<
    Awaited<ReturnType<typeof streamChat>> extends AsyncGenerator<infer T> ? T : never,
    { type: 'stop' }
  >

  for (let turn = 0; turn < maxTurns; turn += 1) {
    let stopEvent: StopEvent | undefined
    turnCatalog = {
      tools: params.tools,
      deferred: [],
      deferredEnabled: false,
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
      try {
        const mainRoute = getProviderFor(config, roleModel)
        dispatchCtx.mainTurnRouting = {
          provider: mainRoute.provider,
          schema: mainRoute.provider.name,
          endpoint: mainRoute.entry.endpoint,
          endpointBaseUrl: config.endpoints[mainRoute.entry.endpoint]?.baseUrl,
          upstreamModel: mainRoute.entry.upstreamModel,
        }
        for await (const event of streamChat({
          config,
          model: roleModel,
          messages: toApiMessages(messages),
          system: renderedPrompt.system,
          ...(renderedPrompt.systemVariableSuffix
            ? { systemVariableSuffix: renderedPrompt.systemVariableSuffix }
            : {}),
          tools: turnCatalog.tools.map(toolToAPISchema),
          cacheBreakpointMessageIndex: invocation.cacheBreakpointMessageIndex,
          signal,
          apiLogContext: {
            kind: apiLogKind,
            ...(apiLogKind === 'subagent' && invocation.subagentLabel
              ? { subagentLabel: invocation.subagentLabel }
              : {}),
            turn,
            attempt,
          },
        })) {
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
          if (shouldRetry) {
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
    // ensures the channel reply / AgentTool tool_result preserve everything
    // the model actually said, not just whatever the final turn happened to
    // emit.
    const turnText = collectAssistantText(stopEvent.content)
    if (turnText.length > 0) {
      assistantTexts.push(turnText)
      if (invocation.onAssistantTurn) {
        try {
          await invocation.onAssistantTurn(turnText)
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

    for (const hook of lifecycleHooks) {
      await hook.afterAssistantMessage?.(makeHookContext())
    }

    if (toolUses.length === 0) {
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
          process.stderr.write(
            `query: injected ${lateInterjections.length} late interjection${lateInterjections.length === 1 ? '' : 's'} after end_turn\n`,
          )
          // Loop back to send the new user message to the LLM.
          continue
        }
      }
      const extractionSnapshot = [...messages]
      if (!invocation.ephemeral) {
        await maybeUpdateSessionMemory(extractionSnapshot)
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
    }

    if (!invocation.ephemeral) {
      await maybeUpdateSessionMemory([...messages])
      for (const hook of lifecycleHooks) {
        await hook.afterEndTurn?.(makeHookContext(), stopEvent.usage)
      }
    }
  }

  throw new Error(`Exceeded maximum tool turns (${maxTurns}).`)
  }  // end queryInner
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
