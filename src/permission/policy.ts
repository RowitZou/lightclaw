import { getActiveSkillAllowedTools } from '../state.js'
import type {
  PermissionAskDecision,
  PermissionDecision,
  PermissionMode,
  PermissionRule,
  RiskLevel,
} from './types.js'
import { findHardlineMatch } from './hardline.js'
import { matchMcpToolContent, matchToolContent } from './matchers.js'
import { formatRule } from './rules.js'

export function evaluatePermission(args: {
  toolName: string
  toolSource?: 'builtin' | 'mcp'
  mcpServer?: string
  mcpToolName?: string
  input: unknown
  riskLevel: RiskLevel
  mode: PermissionMode
  rules: PermissionRule[]
}): PermissionDecision | PermissionAskDecision {
  const { toolName, toolSource, mcpServer, mcpToolName, input, riskLevel, mode, rules } = args

  // Hardline blocklist outranks identity allow rules, mode = bypassPermissions,
  // and the ceiling. Patterns block catastrophic shell commands (`rm -rf /`,
  // `mkfs`, `dd of=/dev/sda`, fork bomb, `shutdown`) whose blast radius is the
  // host or container filesystem. The companion to high-risk.ts: where that
  // hardens the ASK flow by hiding 以后都允许, hardline hardens the BYPASS flow.
  if (toolName === 'Bash') {
    const cmd = (input as { command?: unknown })?.command
    if (typeof cmd === 'string') {
      const hardline = findHardlineMatch(cmd)
      if (hardline) {
        return {
          behavior: 'deny',
          reason:
            `Permission denied: hardline blocklist (${hardline.ruleId}) — ${hardline.description}. ` +
            `This rule is unconditional and cannot be overridden by mode, ceiling, or per-rule allow.`,
        }
      }
    }
  }

  const skillBoundary = evaluateSkillBoundary(toolName)
  if (skillBoundary) {
    return skillBoundary
  }

  let firstAllow: PermissionRule | undefined
  let firstAsk: PermissionRule | undefined

  for (const rule of rules) {
    const matchesTool =
      rule.value.toolName === toolName ||
      (rule.value.toolName === 'MCP' &&
        toolSource === 'mcp' &&
        matchMcpToolContent(rule.value.ruleContent, mcpServer, mcpToolName))

    if (!matchesTool) {
      continue
    }

    if (
      rule.value.toolName !== 'MCP' &&
      !matchToolContent(toolName, rule.value.ruleContent, input)
    ) {
      continue
    }

    if (rule.behavior === 'deny') {
      return {
        behavior: 'deny',
        reason: `Permission denied: ${toolName} matched deny rule ${formatRule(rule.value)} from ${rule.source}.`,
        matchedRule: rule,
      }
    }

    if (rule.behavior === 'ask') {
      firstAsk ??= rule
    } else {
      firstAllow ??= rule
    }
  }

  // ask wins over allow and over the mode default — it is an explicit
  // "always confirm this" override that must work even under
  // bypassPermissions.
  if (firstAsk) {
    return { behavior: 'ask' }
  }

  if (firstAllow) {
    return { behavior: 'allow', matchedRule: firstAllow }
  }

  if (mode === 'bypassPermissions') {
    return { behavior: 'allow' }
  }

  if (mode === 'plan') {
    if (riskLevel === 'safe') {
      return { behavior: 'allow' }
    }

    return {
      behavior: 'deny',
      reason: `Permission denied: ${mode} mode forbids ${riskLevel} tool ${toolName}. Explain the plan or ask the user to switch mode/add an allow rule.`,
    }
  }

  if (mode === 'acceptEdits') {
    // WebFetch is read-only against the network, doesn't write disk or run
    // arbitrary commands; in auto mode we treat it as non-execute so users
    // aren't asked once per hostname (`docs.example.com`, `api.example.com`,
    // ...). To force confirmation on a specific host (e.g. an internal
    // service) add an explicit ask rule like `WebFetch(localhost)` — `ask`
    // outranks this fallback.
    if (toolName === 'WebFetch') {
      return { behavior: 'allow' }
    }
    return riskLevel === 'execute' ? { behavior: 'ask' } : { behavior: 'allow' }
  }

  return riskLevel === 'safe' ? { behavior: 'allow' } : { behavior: 'ask' }
}

function evaluateSkillBoundary(toolName: string): PermissionDecision | null {
  // UseSkill / ToolSearch are meta-tools, not capability tools. UseSkill lets
  // the agent switch to another skill mid-task; ToolSearch loads the schema
  // for any deferred tool already named in the skill's allowlist (Phase 31
  // moved Memory*/Web*/etc into deferred, so a skill listing `MemoryWrite`
  // implicitly depends on ToolSearch to fetch its schema). Forcing every
  // skill to enumerate the meta layer in `allowed_tools` would leak the
  // deferred-loading mechanism into skill authors' surface.
  if (toolName === 'UseSkill' || toolName === 'ToolSearch') {
    return null
  }

  const allowedTools = getActiveSkillAllowedTools()
  if (!allowedTools) {
    return null
  }

  if (allowedTools.some(pattern => matchesToolPattern(toolName, pattern))) {
    return null
  }

  return {
    behavior: 'deny',
    reason: `Permission denied: active skill allows only ${allowedTools.join(', ')}; ${toolName} is outside that boundary.`,
  }
}

function matchesToolPattern(toolName: string, pattern: string): boolean {
  if (pattern === toolName || pattern === '*') {
    return true
  }
  if (pattern.endsWith('*')) {
    return toolName.startsWith(pattern.slice(0, -1))
  }
  return false
}
