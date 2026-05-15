import { getConfig } from '../config.js'
import { buildSubagentPrompt } from '../prompt.js'
import { getProvider } from '../provider/index.js'
import { getCurrentUserId, getRuntime } from '../state.js'
import { getCurrentSessionContext } from '../session-context.js'
import type { CanUseToolFn, Tool } from '../tool.js'
import type { AgentDefinition, AgentType, WorkerFailure, WorkerFailureReason } from './types.js'
import { getAgent } from './registry.js'
import {
  createCacheSafeParams,
  getLastCacheSafeParams,
} from './cache-safe-params.js'
import { runForkedAgent } from './forked-agent.js'

// Block list applied to user-facing subagents only (those dispatched via
// AgentTool from the main agent loop). Internal subagents (memory extraction,
// autoDream) bypass this gate because they specifically need MemoryWrite — the
// caller supplies its own canUseTool override (e.g. createAutoMemCanUseTool).
const BLOCKED_SUBAGENT_TOOLS = new Set([
  'AgentTool',
  'BackgroundTask',
  'notify_user',
  'stay_silent',
  'TodoWrite',
  'MemoryWrite',
])

function filterTools(
  agent: AgentDefinition,
  enabledTools: Tool[],
): Tool[] {
  const names = agent.tools.includes('*') ? null : new Set(agent.tools)
  const applyBlocklist = agent.kind !== 'internal'
  return enabledTools.filter(tool => {
    if (applyBlocklist && BLOCKED_SUBAGENT_TOOLS.has(tool.name)) {
      return false
    }

    return !names || names.has(tool.name)
  })
}

export function createSubagentCanUseTool(
  definitionTools: string[] | ['*'],
): CanUseToolFn {
  const allowedTools = definitionTools.includes('*')
    ? null
    : new Set(definitionTools)
  return async tool => {
    if (BLOCKED_SUBAGENT_TOOLS.has(tool.name)) {
      return {
        behavior: 'deny',
        reason: `${tool.name} is not available to subagents.`,
      }
    }
    if (allowedTools && !allowedTools.has(tool.name)) {
      return {
        behavior: 'deny',
        reason: `${tool.name} is not in this subagent's allowed tool set.`,
      }
    }
    return { behavior: 'allow' }
  }
}

export async function runSubagent(params: {
  agentType: AgentType
  prompt: string
  signal?: AbortSignal
  // Optional override for the runtime tool gate. Internal subagents (memory
  // extraction, autoDream) need MemoryWrite, which the default user-facing
  // gate denies — they pass createAutoMemCanUseTool(memoryDir) here.
  canUseToolOverride?: CanUseToolFn
  // Optional explicit canonical user for cacheSafeParams lookup. AgentTool
  // dispatch falls back to getCurrentUserId() (it runs synchronously inside
  // the main turn's ALS scope); internal subagents (extract / dream) fire
  // asynchronously after the main turn ends and can outlive the ALS scope,
  // so they pass their stashed canonicalUser explicitly to guarantee the
  // fork sees the right user's forkContextMessages.
  canonicalUserOverride?: string
  // Optional override for the per-subagent turn cap. Internal subagents
  // (autoDream) source their cap from a user-tunable config knob, so they
  // pass it explicitly rather than baking it into the AgentDefinition.
  maxTurnsOverride?: number
}): Promise<RunSubagentResult> {
  const agent = getAgent(params.agentType)
  if (!agent) {
    return subagentFailure('tool-unavailable', `Unknown agent: ${params.agentType}`, {
      kind: 'give-up',
      detail: 'Pick one of the available subagent types.',
    })
  }
  if (agent.kind === 'internal' && !params.canUseToolOverride) {
    return subagentFailure('tool-unavailable',
      `Internal subagent "${params.agentType}" requires canUseToolOverride; default user-facing gate would deny MemoryWrite.`,
      { kind: 'give-up' },
    )
  }

  const config = getConfig()
  const provider = getProvider(config)
  // Dynamic import: tools.ts → tools/background-task.ts → background-task/
  // runner.ts → query.ts → memory/extract.ts → agents/run-subagent.ts forms
  // a module-load cycle. Loading it lazily here (when the subagent actually
  // runs, well after module evaluation) sidesteps the TDZ that the static
  // import otherwise triggers on backgroundTaskTool.
  const { getAllTools, getEnabledTools } = await import('../tools.js')
  const tools = filterTools(
    agent,
    getEnabledTools(provider, getAllTools(getCurrentSessionContext()?.channel)),
  )
  // Inherit the parent's recent fork-context messages (so the subagent sees
  // the conversation history it should reason over) but build a fresh
  // systemPrompt + tools array specific to this agent — buildSubagentPrompt
  // strips the main agent's "## Available Skills" section that previously
  // misled extract_memories / auto_dream into calling UseSkill instead of
  // MemoryWrite. The model is also kept identical (cache key alignment is
  // governed by systemPrompt + tools + messages; the model itself is one of
  // those keys).
  const cacheUserKey = params.canonicalUserOverride ?? getCurrentUserId()
  const existingCache = getLastCacheSafeParams(cacheUserKey)
  const cacheSafeParams = createCacheSafeParams({
    systemPrompt: buildSubagentPrompt(tools, getRuntime().workspaceRoot, agent),
    tools,
    messages: existingCache?.forkContextMessages ?? [],
    config,
  })

  // Resolve the subagent turn cap: caller override wins (autoDream pulls
  // from config.autoDream.maxTurns), then per-agent definition default, then
  // the operator-supplied config.subagentMaxTurns, otherwise no cap (parity
  // with Claude Code, which has no documented default for Task subagents).
  const subagentMaxTurns =
    params.maxTurnsOverride ?? agent.maxTurns ?? config.subagentMaxTurns
  try {
    const result = await runForkedAgent({
      promptText: params.prompt,
      cacheSafeParams,
      role: agent,
      canUseTool:
        params.canUseToolOverride ?? createSubagentCanUseTool(agent.tools),
      ...(subagentMaxTurns !== undefined ? { maxTurns: subagentMaxTurns } : {}),
      label:
        agent.kind === 'internal'
          ? params.agentType
          : `subagent_${params.agentType}`,
      signal: params.signal,
    })

    return {
      kind: 'success',
      finalText: result.finalText,
      stopReason: result.stopReason,
    }
  } catch (error) {
    return subagentFailureForError(error, params.signal)
  }
}

export type RunSubagentResult =
  | { kind: 'success'; finalText: string; stopReason: string | null }
  | { kind: 'failure'; envelope: WorkerFailure }

function subagentFailure(
  reason: WorkerFailureReason,
  message: string,
  suggestedAction?: WorkerFailure['suggested_action'],
  partialResult?: string,
): RunSubagentResult {
  return {
    kind: 'failure',
    envelope: {
      status: 'failed',
      reason,
      message,
      ...(partialResult ? { partial_result: partialResult } : {}),
      ...(suggestedAction ? { suggested_action: suggestedAction } : {}),
    },
  }
}

function subagentFailureForError(
  error: unknown,
  signal?: AbortSignal,
): RunSubagentResult {
  const message = error instanceof Error ? error.message : String(error)
  if (signal?.aborted || isAbortLikeError(error)) {
    return subagentFailure('aborted', message || 'Subagent was aborted.', {
      kind: 'retry-with-narrower-scope',
      detail: 'The caller may retry if the task is still needed.',
    })
  }
  if (/Exceeded maximum tool turns/i.test(message)) {
    return subagentFailure('max-turns-exceeded', message, {
      kind: 'retry-with-narrower-scope',
      detail: 'Reduce scope or increase the subagent turn cap.',
    })
  }
  return subagentFailure('other', message, { kind: 'ask-user' })
}

function isAbortLikeError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  return error.name === 'AbortError' || /aborted|abort/i.test(error.message)
}

export function formatWorkerFailureForToolResult(envelope: WorkerFailure): string {
  const lines = [
    `**Failed**: ${envelope.reason}`,
    `Message: ${envelope.message}`,
  ]
  if (envelope.partial_result) {
    lines.push('', 'Partial result:', envelope.partial_result)
  }
  if (envelope.suggested_action) {
    lines.push(
      '',
      `Suggested action: ${envelope.suggested_action.kind}` +
        (envelope.suggested_action.detail
          ? ` — ${envelope.suggested_action.detail}`
          : ''),
    )
  }
  return lines.join('\n')
}
