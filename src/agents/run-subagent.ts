import { getConfig } from '../config.js'
import { resolveRoleMaxTurns, resolveRoleModel } from '../model-resolution.js'
import { getProviderFor } from '../provider/index.js'
import { getCurrentUserId } from '../state.js'
import { getCurrentSessionContext } from '../session-context.js'
import type { CanUseToolFn, Tool } from '../tool.js'
import type { AgentType, Role, WorkerFailure, WorkerFailureReason } from './types.js'
import { getAgent } from './registry.js'
import { runDispatchedAgent } from './dispatched-agent.js'
import { isToolVisibleToRole } from './role-tool-gate.js'

function filterTools(
  agent: Role,
  enabledTools: Tool[],
): Tool[] {
  return enabledTools.filter(tool => isToolVisibleToRole(agent, tool.name))
}

export async function runSubagent(params: {
  agentType: AgentType
  prompt: string
  signal?: AbortSignal
  // Optional input-sensitive runtime tool gate. Internal subagents keep using
  // this escape hatch for defense-in-depth policies that cannot be expressed
  // as role.tools presence alone, such as "Bash is allowed only for read-only
  // heads" in createAutoMemCanUseTool(memoryDir).
  canUseToolOverride?: CanUseToolFn
  // Optional explicit canonical user for post-dispatch memory extraction.
  // AgentTool dispatch falls back to getCurrentUserId() (it runs synchronously
  // inside the main turn's ALS scope); internal subagents (extract / dream)
  // can fire asynchronously after the main turn ends.
  canonicalUserOverride?: string
  // Optional override for the per-subagent turn cap. Internal subagents
  // (autoDream) source their cap from a user-tunable config knob, so they
  // pass it explicitly rather than baking it into the Role.
  maxTurnsOverride?: number
  // Used by Phase 3 per-role extract: prompt/tools/gate still come from the
  // child agent Role, but MemoryWrite's physical binding sees this owner Role.
  currentRoleOverride?: Role
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
      `Internal subagent "${params.agentType}" requires canUseToolOverride for its input-sensitive runtime gate.`,
      { kind: 'give-up' },
    )
  }

  const config = getConfig()
  const roleModel = resolveRoleModel(agent, config)
  const provider = getProviderFor(config, roleModel).provider
  // Dynamic import: tools.ts → tools/background-task.ts → background-task/
  // runner.ts → query.ts → memory/extract.ts → agents/run-subagent.ts forms
  // a module-load cycle. Loading it lazily here (when the subagent actually
  // runs, well after module evaluation) sidesteps the TDZ that the static
  // import otherwise triggers on backgroundTaskTool.
  const { getAllTools, getEnabledTools } = await import('../tools.js')
  const tools = filterTools(
    agent,
    getEnabledTools(
      provider,
      getAllTools(getCurrentSessionContext()?.channel, {
        includeInternal: agent.kind === 'internal',
      }),
    ),
  )
  // Dispatch semantics: the worker starts from exactly one caller-authored
  // prompt. The runner does not inherit the parent transcript; callers that
  // want context (extract / autoDream) must include it in params.prompt.
  const cacheUserKey = params.canonicalUserOverride ?? getCurrentUserId()

  // Resolve the subagent turn cap: caller override wins (autoDream pulls
  // from config.autoDream.maxTurns), then per-role config/default, then the
  // operator-supplied config.subagentMaxTurns, otherwise no cap (parity with
  // Claude Code, which has no documented default for Task subagents).
  const subagentMaxTurns =
    params.maxTurnsOverride
    ?? resolveRoleMaxTurns(agent, config)
    ?? config.subagentMaxTurns
  try {
    const result = await runDispatchedAgent({
      dispatchPrompt: params.prompt,
      tools,
      config,
      role: agent,
      currentRoleOverride: params.currentRoleOverride,
      canUseToolOverride: params.canUseToolOverride,
      ...(subagentMaxTurns !== undefined ? { maxTurns: subagentMaxTurns } : {}),
      label:
        agent.kind === 'internal'
          ? params.agentType
          : `subagent_${params.agentType}`,
      signal: params.signal,
    })
    maybeTriggerForkExtract({
      agent,
      result,
      canonicalUser: cacheUserKey,
      config,
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

function maybeTriggerForkExtract(input: {
  agent: Role
  result: Awaited<ReturnType<typeof runDispatchedAgent>>
  canonicalUser: string | undefined
  config: ReturnType<typeof getConfig>
}): void {
  const parentCtx = getCurrentSessionContext()
  if (
    !parentCtx
    || !input.canonicalUser
    || !input.result.forkTranscriptPath
    || !input.config.autoMemory
  ) {
    return
  }
  if (input.agent.kind !== 'worker') {
    return
  }

  void input.result.forkTranscriptPersisted
    .then(async persistedPath => {
      if (!persistedPath) return
      const { triggerForkExtract } = await import('../memory/extract.js')
      await triggerForkExtract({
        canonicalUser: input.canonicalUser,
        ownerRole: input.agent,
        forkTranscriptPath: persistedPath,
        memoryDir: parentCtx.memoryDir,
        config: input.config,
      })
    })
    .catch(error => {
      const message = error instanceof Error ? error.message : String(error)
      process.stderr.write(`[memory] fork extraction failed: ${message}\n`)
    })
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
