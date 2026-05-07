import type { PermissionDenialDetail } from '../background-task/types.js'

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
  | 'identity'
  | 'local'
  | 'project'
  | 'user'
  | 'builtin'

export type PermissionRuleValue = {
  toolName: string
  ruleContent?: string
}

export type PermissionRule = {
  source: PermissionRuleSource
  behavior: PermissionBehavior
  value: PermissionRuleValue
}

export type PermissionDecision =
  | { behavior: 'allow'; matchedRule?: PermissionRule }
  | { behavior: 'deny'; reason: string; matchedRule?: PermissionRule }

export type PermissionAskDecision = {
  behavior: 'ask'
}

export type PermissionAskInput = {
  toolName: string
  riskLevel: RiskLevel
  input: unknown
  inputPreview: string
  mode: PermissionMode
  signal?: AbortSignal
  suggestedRules: PermissionRuleValue[]
}

export type PermissionApprover = {
  ask(input: PermissionAskInput): Promise<PermissionDecision>
}

export type PermissionContext = {
  isInteractive: boolean
  isSubagent: boolean
  signal?: AbortSignal
  permissionApprover?: PermissionApprover
  isBackgroundTask?: boolean
  taskAllowedTools?: string[]
  onPermissionDenial?: (detail: PermissionDenialDetail) => void
}
