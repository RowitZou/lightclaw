import type { PermissionRuleValue } from './types.js'

const RULE_RE = /^([A-Za-z][A-Za-z0-9_]*)(?:\((.*)\))?$/

export function parseRule(text: string): PermissionRuleValue {
  const trimmed = text.trim()
  const match = trimmed.match(RULE_RE)
  if (!match) {
    throw new Error(`Invalid permission rule: ${trimmed || '(empty)'}`)
  }

  const [, toolName, ruleContent] = match
  return ruleContent === undefined
    ? { toolName }
    : { toolName, ruleContent }
}

export function formatRule(value: PermissionRuleValue): string {
  return value.ruleContent === undefined
    ? value.toolName
    : `${value.toolName}(${value.ruleContent})`
}

export function parseRules(texts: string[]): PermissionRuleValue[] {
  return texts.map(parseRule)
}
