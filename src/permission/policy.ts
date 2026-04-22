import type {
  PermissionAskDecision,
  PermissionDecision,
  PermissionMode,
  PermissionRule,
  RiskLevel,
} from './types.js'
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
  let firstAllow: PermissionRule | undefined

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

    firstAllow ??= rule
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
    return riskLevel === 'execute' ? { behavior: 'ask' } : { behavior: 'allow' }
  }

  return riskLevel === 'safe' ? { behavior: 'allow' } : { behavior: 'ask' }
}
