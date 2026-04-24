import { appendFileSync } from 'node:fs'

import { formatRule } from './rules.js'
import type { HookAuditEntry } from '../hooks/types.js'
import type { PermissionDecision, PermissionMode, PermissionRule } from './types.js'

function formatMatchedRule(rule: PermissionRule): string {
  return `${rule.source}:${rule.behavior}:${formatRule(rule.value)}`
}

export function recordAudit(input: {
  path?: string
  toolName: string
  mcpServer?: string
  decision: PermissionDecision
  mode: PermissionMode
  isSubagent: boolean
  source?: 'permission' | 'hook' | 'feishu'
  hookDecisionBefore?: 'allow' | 'deny'
  hookReason?: string
}): void {
  if (!input.path) {
    return
  }

  const line = JSON.stringify({
    ts: new Date().toISOString(),
    tool: input.toolName,
    ...(input.mcpServer ? { mcpServer: input.mcpServer } : {}),
    source: input.source ?? 'permission',
    decision: input.decision.behavior,
    mode: input.mode,
    ...(input.hookDecisionBefore ? { hookDecisionBefore: input.hookDecisionBefore } : {}),
    ...(input.hookReason ? { hookReason: input.hookReason } : {}),
    matchedRule: input.decision.matchedRule
      ? formatMatchedRule(input.decision.matchedRule)
      : null,
    isSubagent: input.isSubagent,
  })

  try {
    appendFileSync(input.path, `${line}\n`, 'utf8')
  } catch {
    // Audit logging must never block the agent loop.
  }
}

export function recordHookAudit(input: HookAuditEntry & { path?: string }): void {
  if (!input.path) {
    return
  }

  const line = JSON.stringify({
    ts: new Date().toISOString(),
    source: 'hook',
    hook: input.hook,
    hookName: input.hookName,
    file: input.file,
    ...(input.result !== undefined ? { result: input.result } : {}),
    ...(input.error ? { error: input.error } : {}),
  })

  try {
    appendFileSync(input.path, `${line}\n`, 'utf8')
  } catch {
    // Audit logging must never block the agent loop.
  }
}
