export const PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
] as const

export type PermissionMode = (typeof PERMISSION_MODES)[number]
export type RiskLevel = 'safe' | 'write' | 'execute'
export type PermissionBehavior = 'allow' | 'deny' | 'ask'
export type PermissionRuleSource =
  | 'cliArg'
  | 'session'
  | 'local'
  | 'project'
  | 'user'

export type PermissionRuleValue = {
  toolName: string
  ruleContent?: string
}

export type PermissionRule = {
  source: PermissionRuleSource
  behavior: 'allow' | 'deny'
  value: PermissionRuleValue
}

export type PermissionDecision =
  | { behavior: 'allow'; matchedRule?: PermissionRule }
  | { behavior: 'deny'; reason: string; matchedRule?: PermissionRule }

export type PermissionAskDecision = {
  behavior: 'ask'
}

export type PermissionContext = {
  isInteractive: boolean
  isSubagent: boolean
  signal?: AbortSignal
}
