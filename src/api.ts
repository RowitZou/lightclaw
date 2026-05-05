import { getConfig, type LightClawConfig } from './config.js'
import { getProviderFor } from './provider/index.js'
import type { StreamChatParams } from './provider/types.js'
import type { StreamEvent, UsageStats } from './types.js'
import {
  getActiveApiLogger,
  type ApiLogKind,
  type ApiLogTurnRecord,
} from './api-logs/storage.js'
import { getCurrentUserId, getSessionId } from './state.js'

/**
 * Tag describing which subsystem is making this streamChat call. Plumbed
 * through to the api logger so jsonl readers can filter by call kind
 * (main / subagent / recall / session-memory / compact / tool-summarize).
 *
 * Optional. When absent, the call still passes through to the provider —
 * but it is not logged, since untagged calls cannot be distinguished from
 * each other in the trace. New streamChat callers SHOULD tag themselves.
 */
export interface ApiLogContext {
  kind: ApiLogKind
  /** Set by forked-agent when kind === 'subagent'. */
  subagentLabel?: string
  /** Main-loop turn index. Defaults to 0 when omitted (one-shot kinds). */
  turn?: number
  /** Attempt within turn. Defaults to 0 (only main loop's prompt-too-long
   *  retry path uses attempt > 0). */
  attempt?: number
}

export async function* streamChat(
  params: StreamChatParams & {
    config?: LightClawConfig
    apiLogContext?: ApiLogContext
  },
): AsyncGenerator<StreamEvent> {
  const { config: paramConfig, apiLogContext, ...rest } = params
  const config = paramConfig ?? getConfig()
  // The caller passes a display model name (the key in config.models).
  // Resolve it once here to (a) pick the right provider instance, and
  // (b) substitute the real upstream id for the wire request. Logging
  // continues to record the display name on the log record so traces stay
  // aligned with what the user sees in `/model` and routing config.
  const { provider, entry } = getProviderFor(config, rest.model)
  const wireParams = { ...rest, model: entry.upstreamModel }

  const logger = getActiveApiLogger()
  // Fast path: no active query scope OR caller didn't tag the call. Bail
  // before touching the buffering branch so cost stays at zero.
  if (!logger || !apiLogContext) {
    yield* provider.streamChat(wireParams)
    return
  }

  let stopContent: unknown[] | undefined
  let stopReason: string | null = null
  let stopUsage: UsageStats = {}
  let errorRec: { name: string; message: string } | null = null

  try {
    for await (const event of provider.streamChat(wireParams)) {
      if (event.type === 'stop') {
        stopContent = event.content
        stopReason = event.stopReason
        stopUsage = event.usage
      }
      yield event
    }
  } catch (error) {
    errorRec = {
      name: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : String(error),
    }
    throw error
  } finally {
    const record: ApiLogTurnRecord = {
      kind: apiLogContext.kind,
      ...(apiLogContext.subagentLabel
        ? { subagentLabel: apiLogContext.subagentLabel }
        : {}),
      sessionId: getSessionId(),
      ...(getCurrentUserId() ? { user: getCurrentUserId()! } : {}),
      turn: apiLogContext.turn ?? 0,
      attempt: apiLogContext.attempt ?? 0,
      ts: new Date().toISOString(),
      model: rest.model,
      request: {
        system: rest.system,
        tools: rest.tools,
        messages: rest.messages,
        ...(rest.cacheBreakpointMessageIndex !== undefined
          ? { cacheBreakpointMessageIndex: rest.cacheBreakpointMessageIndex }
          : {}),
      },
      ...(errorRec
        ? { error: errorRec }
        : stopContent !== undefined
          ? {
              response: {
                content: stopContent,
                stopReason,
                usage: stopUsage,
              },
            }
          : {}),
    }
    void logger.appendTurn(record)
  }
}
