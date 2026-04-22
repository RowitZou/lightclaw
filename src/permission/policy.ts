import type {
  PermissionAskDecision,
  PermissionDecision,
  PermissionMode,
  PermissionRule,
  RiskLevel,
} from './types.js'
import { matchToolContent } from './matchers.js'
import { formatRule } from './rules.js'

export function evaluatePermission(args: {
  toolName: string
  input: unknown
  riskLevel: RiskLevel
  mode: PermissionMode
  rules: PermissionRule[]
}): PermissionDecision | PermissionAskDecision {
  const { toolName, input, riskLevel, mode, rules } = args
  let firstAllow: PermissionRule | undefined

  for (const rule of rules) {
    if (rule.value.toolName !== toolName) {
      continue
    }

    if (!matchToolContent(toolName, rule.value.ruleContent, input)) {
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
