import { getConfig } from '../config.js'
import {
  getAllPermissionRules,
  getCurrentUserId,
  getPermissionApprover,
  getPermissionMode,
  setIdentityRules,
} from '../state.js'
import type { Tool } from '../tool.js'
import { recordAudit } from './audit.js'
import { evaluatePermission } from './policy.js'
import { formatRule } from './rules.js'
import { loadIdentityRules } from './storage.js'
import type {
  PermissionContext,
  PermissionDecision,
  PermissionRuleValue,
} from './types.js'
import { matchesUnattendedAllowlist } from './unattended-allowlist.js'

export async function requestPermission(input: {
  tool: Tool
  toolInput: unknown
  ctx: PermissionContext
}): Promise<PermissionDecision> {
  const { tool, toolInput, ctx } = input
  const config = getConfig()
  const mode = getPermissionMode()
  // Identity rules are persisted per-canonical-user but cached as an
  // in-memory snapshot on each `SessionContext` (Phase 20 ALS isolation).
  // A card-click `allow_rules` runs in the Feishu callback's own ALS
  // context, so it can `setIdentityRules` only on its own snapshot — the
  // long-running query() loop here never sees the new rule until the next
  // resetSessionContext, which in long turns causes the same kind of ASK
  // (e.g. WebSearch x N concurrent / sequential) to keep prompting even
  // after the user already picked "always allow". reevaluateOwnerQueue
  // sweeps already-pending tails (it reloads from disk), but the *next*
  // tool_use evaluatePermission call against this stale snapshot still
  // verdicts 'ask'. Reload from disk on every requestPermission so the
  // freshly-installed rule takes effect immediately. Cost: one tiny JSON
  // read per tool call; permissions.json is per-user and small. Mirror the
  // refresh into the local in-memory snapshot too so callers that read it
  // later in the same tool call (audit / suggester) see the current set.
  const userId = getCurrentUserId()
  if (userId) {
    const fresh = loadIdentityRules(userId)
    setIdentityRules(fresh)
  }
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
  // — no longer auto-denied. After Phase 37 there is no terminal agent loop
  // and no terminal readline ASK fallback; subagents without an approver
  // (test or unattended off-channel paths) fall through to the
  // BackgroundTask allowlist or the final deny branch.
  const approver = ctx.permissionApprover ?? getPermissionApprover()

  let decision: PermissionDecision
  if (verdict.behavior === 'ask') {
    const inputPreview = previewInput(tool.name, toolInput)
    const suggestedRules = computeSuggestedRules(tool, toolInput)
    // The Feishu approver re-computes `isHighRiskAsk(askInput)` from this
    // payload to drive the "hide ‘以后都允许’" UX; no local copy is needed
    // here since Phase 37 removed the terminal readline ASK that used to
    // share the value.
    const askInput = {
      toolName: tool.name,
      riskLevel: tool.riskLevel,
      input: toolInput,
      inputPreview,
      mode,
      signal: ctx.signal,
      suggestedRules,
    }
    if (approver) {
      decision = await approver.ask(askInput)
    } else if (ctx.isBackgroundTask) {
      if (matchesUnattendedAllowlist(tool, toolInput, ctx.taskAllowedTools)) {
        decision = { behavior: 'allow' }
      } else {
        decision = {
          behavior: 'deny',
          reason: [
            `Permission denied: ${tool.name} not in background-task allowlist.`,
            `background-task-not-in-allowlist: ${tool.name} requires confirmation in ${mode} mode, but no approver is attached.`,
            'Add this operation to the task allowed_tools and retry.',
          ].join(' '),
        }
        // Only the ask→fallback-deny path is repairable by adding the suggested
        // rule to task.allowedTools. Identity deny rules (verdict.behavior ===
        // 'deny' below) are NOT repairable that way — task.allowedTools is
        // outranked by deny rules in evaluatePermission, so surfacing those
        // denials would loop the user through approve→retry→deny indefinitely.
        // Keep the callback strictly to "verdict was ask, allowlist denied".
        ctx.onPermissionDenial?.({
          toolName: tool.name,
          inputPreview,
          suggestedRules: suggestedRules.map(formatRule),
        })
      }
    } else {
      decision = {
        behavior: 'deny',
        reason: [
          `Permission denied: ${tool.name} requires confirmation in ${mode} mode.`,
          ctx.isSubagent
            ? 'No approver is wired for this subagent.'
            : 'No approver is attached to this session.',
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
    isBackgroundTask: ctx.isBackgroundTask,
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
