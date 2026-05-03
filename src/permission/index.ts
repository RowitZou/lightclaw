import type { Interface } from 'node:readline/promises'

import { getConfig } from '../config.js'
import {
  getAllPermissionRules,
  getPermissionApprover,
  getPermissionMode,
} from '../state.js'
import type { Tool } from '../tool.js'
import { recordAudit } from './audit.js'
import { evaluatePermission } from './policy.js'
import { askUserApproval } from './prompt.js'
import type {
  PermissionContext,
  PermissionDecision,
  PermissionRuleValue,
} from './types.js'

export async function requestPermission(input: {
  tool: Tool
  toolInput: unknown
  ctx: PermissionContext
  rl?: Interface
}): Promise<PermissionDecision> {
  const { tool, toolInput, ctx, rl } = input
  const config = getConfig()
  const mode = getPermissionMode()
  const verdict = evaluatePermission({
    toolName: tool.name,
    toolSource: tool.source,
    mcpServer: tool.mcpServer,
    mcpToolName: tool.mcpToolName,
    input: toolInput,
    riskLevel: tool.riskLevel,
    mode,
    rules: getAllPermissionRules(),
  })

  // Approver is channel-injected via state on every query() entry, but the
  // ctx field still wins when explicitly provided (test injection / future
  // per-call override). State approver is shared by main agent and subagents
  // so a forked subagent's permission ask routes to the same Feishu card UX
  // — no longer auto-denied. Subagents without an approver (terminal forks)
  // fall through to the readline path or the final deny branch.
  const approver = ctx.permissionApprover ?? getPermissionApprover()

  let decision: PermissionDecision
  if (verdict.behavior === 'ask') {
    const inputPreview = previewInput(tool.name, toolInput)
    const suggestedRules = computeSuggestedRules(tool, toolInput)
    if (approver) {
      decision = await approver.ask({
        toolName: tool.name,
        riskLevel: tool.riskLevel,
        input: toolInput,
        inputPreview,
        mode,
        signal: ctx.signal,
        suggestedRules,
      })
    } else if (ctx.isInteractive && rl) {
      decision = await askUserApproval({
        rl,
        toolName: tool.name,
        riskLevel: tool.riskLevel,
        inputPreview,
        suggestedRules,
      })
    } else {
      decision = {
        behavior: 'deny',
        reason: [
          `Permission denied: ${tool.name} requires confirmation in ${mode} mode.`,
          ctx.isSubagent
            ? 'No approver is wired for this subagent (terminal fork).'
            : 'No interactive prompt is available.',
          'Add an explicit allow rule or switch permission mode before retrying.',
        ].join(' '),
      }
    }
  } else {
    decision = verdict
  }

  recordAudit({
    path: config.permissionAuditLog,
    toolName: tool.name,
    mcpServer: tool.mcpServer,
    decision,
    mode,
    isSubagent: ctx.isSubagent,
  })

  return decision
}

function computeSuggestedRules(
  tool: Tool,
  toolInput: unknown,
): PermissionRuleValue[] {
  // Tool implementations are typed; the dispatcher hands us `unknown`. Cast
  // is safe because Zod has already validated the input shape upstream.
  const suggester = tool.suggestPermissionRules as
    | ((input: unknown) => PermissionRuleValue[])
    | undefined
  const suggestions = suggester?.(toolInput)
  if (suggestions && suggestions.length > 0) {
    return suggestions
  }
  // Fallback: a single tool-wide allow rule. Approvers render this set as a
  // single "always allow X" button — when the suggester produces nothing
  // precise (relative path / opaque MCP input / etc.) the broad fallback is
  // the only meaningful "don't ask again" scope we can offer.
  return [{ toolName: tool.name }]
}

function previewInput(toolName: string, input: unknown): string {
  const record = input as Record<string, unknown>
  if (toolName === 'Bash' && typeof record.command === 'string') {
    return `Command: ${truncate(record.command, 200)}`
  }

  if (toolName === 'WebFetch' && typeof record.url === 'string') {
    return `URL: ${record.url}`
  }

  if (
    (toolName === 'Read' || toolName === 'Write' || toolName === 'Edit') &&
    typeof record.file_path === 'string'
  ) {
    return `Path: ${record.file_path}`
  }

  if (toolName === 'AgentTool' && typeof record.subagent_type === 'string') {
    return `Subagent: ${record.subagent_type}`
  }

  if (toolName.startsWith('mcp__')) {
    return `MCP input: ${truncate(JSON.stringify(record), 200)}`
  }

  try {
    return `Input: ${truncate(JSON.stringify(record), 200)}`
  } catch {
    return 'Input: (unserializable)'
  }
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value
}
