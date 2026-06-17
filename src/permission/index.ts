import { isUserDefinedAgent } from '../agents/registry.js'
import { getConfig } from '../config.js'
import { loadIdentityPreferences } from '../identity/preferences.js'
import { getCurrentRole } from '../state.js'
import {
  getAllPermissionRules,
  getCurrentUserId,
  getPermissionApprover,
  getPermissionMode,
  setIdentityRules,
  setPermissionMode,
} from '../state.js'
import type { Tool } from '../tool.js'
import { recordAudit } from './audit.js'
import { commandContainsHighRiskBash, isHighRiskAsk, isHighRiskPathLiteral } from './high-risk.js'
import { evaluatePermission } from './policy.js'
import { formatRule } from './rules.js'
import { loadIdentityRules } from './storage.js'
import type {
  PermissionContext,
  PermissionDecision,
  PermissionRuleValue,
} from './types.js'

export async function requestPermission(input: {
  tool: Tool
  toolInput: unknown
  ctx: PermissionContext
}): Promise<PermissionDecision> {
  const { tool, toolInput, ctx } = input
  const config = getConfig()
  // Identity rules AND permission mode are persisted per-canonical-user but
  // cached as an in-memory snapshot on each `SessionContext` (Phase 20 ALS
  // isolation).
  //
  // Rules: a card-click `allow_rules` runs in the Feishu callback's own ALS
  // context, so it can `setIdentityRules` only on its own snapshot — the
  // long-running query() loop here never sees the new rule until the next
  // resetSessionContext, which in long turns causes the same kind of ASK
  // (e.g. WebSearch x N concurrent / sequential) to keep prompting even
  // after the user already picked "always allow". reevaluateOwnerQueue
  // sweeps already-pending tails (it reloads from disk), but the *next*
  // tool_use evaluatePermission call against this stale snapshot still
  // verdicts 'ask'. Reload from disk on every requestPermission so the
  // freshly-installed rule takes effect immediately. Mirror the refresh into
  // the local in-memory snapshot too so callers that read it later in the
  // same tool call (audit / suggester) see the current set.
  //
  // Mode: the same staleness hits `permissionMode` on a different surface.
  // `/mode bypassPermissions` (yolo) in one session writes the new mode to
  // preferences.json and to that session's snapshot only. A long-running
  // turn in *another* session keeps the old mode for its whole run — most
  // visibly a background-task fire, which snapshots the mode once at fire
  // start (`runBackgroundTaskFire`) and never rebuilds its SessionContext,
  // so it keeps rendering approval cards under the old mode after the user
  // already switched to yolo elsewhere. Foreground turns rebuild context
  // from disk each inbound message and self-heal next turn; a bg fire has no
  // such rebuild point. Reload the persisted mode here too (same one-tiny-
  // JSON-read cost as rules) so a cross-session switch lands at the next
  // tool boundary. Only override when the file actually carries a mode — an
  // absent key keeps the context snapshot, which already encodes the config
  // default chosen at session creation. The ceiling clamp inside
  // getPermissionMode() still caps the freshly-loaded mode.
  const userId = getCurrentUserId()
  if (userId) {
    const fresh = loadIdentityRules(userId)
    setIdentityRules(fresh)
    const freshMode = loadIdentityPreferences(userId).permissionMode
    if (freshMode) {
      setPermissionMode(freshMode)
    }
  }
  const mode = getPermissionMode()
  let verdict = evaluatePermission({
    toolName: tool.name,
    toolSource: tool.source,
    mcpServer: tool.mcpServer,
    mcpToolName: tool.mcpToolName,
    input: toolInput,
    riskLevel: tool.riskLevel,
    mode,
    rules: getAllPermissionRules(),
  })
  // User-defined role override: a persisted "allow always" rule must NOT
  // silently auto-allow a destructive Bash head or a high-risk path write
  // when the caller is a user-authored role. The dev-plan invariant says
  // user-defined roles route every high-risk-by-content op through an
  // explicit ask, even though admin authored the role. Bundled roles keep
  // the standard rule lookup (their tool surfaces are reviewed at PR0
  // byte-lock time, so persisted allows are trusted).
  if (verdict.behavior === 'allow' && shouldForceAskForUserDefinedHighRisk(tool, toolInput)) {
    verdict = { behavior: 'ask' }
  }

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
      // bg-fire (no approver). The role's `tools` allowlist already passed
      // at canUseTool — by the time we reach here, the tool itself is
      // authorized for this role. The only remaining decision is
      // input-level: high-risk inputs must reach a human; everything else
      // auto-allows because the role IS the authorization scope.
      if (isHighRiskAsk(askInput)) {
        decision = {
          behavior: 'deny',
          reason: [
            `Permission denied: ${tool.name} requires confirmation for this input (high-risk).`,
            'A user permission card has been queued; once the user clicks Allow this fire can retry.',
          ].join(' '),
        }
        // Collect for the high-risk → user card path in
        // scheduler.deliverCompletion. Identity deny rules (verdict
        // 'deny' below) are intentionally NOT collected — those are explicit
        // /rules deny, not repairable by a card click.
        ctx.onPermissionDenial?.({
          toolName: tool.name,
          inputPreview,
          suggestedRules: suggestedRules.map(formatRule),
        })
      } else {
        decision = { behavior: 'allow' }
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
    path: config.paths.permissionAudit,
    toolName: tool.name,
    mcpServer: tool.mcpServer,
    decision,
    mode,
    isSubagent: ctx.isSubagent,
    isBackgroundTask: ctx.isBackgroundTask,
  })

  return decision
}

/**
 * Defense-in-depth for user-defined roles: when the caller is a user-authored
 * role (loaded from `<lightclawHome>/roles/<name>/ROLE.md`), high-risk Bash
 * heads and high-risk path writes route through an explicit ask even when
 * the user already granted "以后都允许" for that scope. The "always allow"
 * button itself is already hidden for high-risk asks (see `isHighRiskAsk` +
 * the channel approver's UI), but persisted rules from before a user-defined
 * role existed could still match — this layer closes that loop. Bundled roles
 * are unaffected; their tool surfaces go through PR0 byte-lock review.
 */
function shouldForceAskForUserDefinedHighRisk(tool: Tool, toolInput: unknown): boolean {
  const role = getCurrentRole()
  if (!role || !isUserDefinedAgent(role.agentType)) {
    return false
  }
  if (tool.name === 'Bash') {
    const cmd = (toolInput as { command?: unknown })?.command
    if (typeof cmd === 'string') {
      return commandContainsHighRiskBash(cmd)
    }
  }
  if (tool.name === 'Edit' || tool.name === 'Write' || tool.name === 'Read') {
    const file = (toolInput as { file_path?: unknown })?.file_path
    if (typeof file === 'string') {
      return isHighRiskPathLiteral(file)
    }
  }
  return false
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
