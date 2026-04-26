import path from 'node:path'

import { getCurrentUserId, getCwd, getActiveSkillAllowedTools } from '../state.js'
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
  const skillBoundary = evaluateSkillBoundary(toolName)
  if (skillBoundary) {
    return skillBoundary
  }

  const workspaceBoundary = evaluateWorkspaceBoundary(toolName, input)
  if (workspaceBoundary) {
    return workspaceBoundary
  }

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

function evaluateSkillBoundary(toolName: string): PermissionDecision | null {
  if (toolName === 'UseSkill') {
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

function evaluateWorkspaceBoundary(
  toolName: string,
  input: unknown,
): PermissionDecision | null {
  const targetPath = extractTargetPath(toolName, input)
  if (!targetPath) {
    return null
  }

  const userId = getCurrentUserId()
  if (!userId) {
    return {
      behavior: 'deny',
      reason: `Permission denied: ${toolName} requires an active LightClaw user context.`,
    }
  }

  const cwd = path.resolve(getCwd())
  const resolvedTarget = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(cwd, targetPath)

  if (!isWithin(resolvedTarget, cwd)) {
    return {
      behavior: 'deny',
      reason: `Permission denied: workspace boundary forbids ${toolName} outside the current user workspace.`,
    }
  }

  return null
}

function extractTargetPath(toolName: string, input: unknown): string | null {
  const record = input as Record<string, unknown>
  if (
    (toolName === 'Read' || toolName === 'Write' || toolName === 'Edit') &&
    typeof record.file_path === 'string'
  ) {
    return record.file_path
  }

  if (
    (toolName === 'Glob' || toolName === 'Grep') &&
    typeof record.path === 'string'
  ) {
    return record.path
  }

  return null
}

function isWithin(target: string, root: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
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
