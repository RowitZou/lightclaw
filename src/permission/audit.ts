import { appendFileSync } from 'node:fs'

import { formatRule } from './rules.js'
import type { PermissionDecision, PermissionMode, PermissionRule } from './types.js'

function formatMatchedRule(rule: PermissionRule): string {
  return `${rule.source}:${rule.behavior}:${formatRule(rule.value)}`
}

export function recordAudit(input: {
  path?: string
  toolName: string
  decision: PermissionDecision
  mode: PermissionMode
  isSubagent: boolean
}): void {
  if (!input.path) {
    return
  }

  const line = JSON.stringify({
    ts: new Date().toISOString(),
    tool: input.toolName,
    decision: input.decision.behavior,
    mode: input.mode,
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
