import type { PermissionDenialDetail } from '../background-task/types.js'

export const PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
] as const

export type PermissionMode = (typeof PERMISSION_MODES)[number]

export const PERMISSION_ALIAS_TO_MODE: Record<string, PermissionMode> = {
  read: 'plan',
  ask: 'default',
  auto: 'acceptEdits',
  yolo: 'bypassPermissions',
}

export const PERMISSION_MODE_TO_ALIAS: Record<PermissionMode, string> = {
  plan: 'read',
  default: 'ask',
  acceptEdits: 'auto',
  bypassPermissions: 'yolo',
}

export const PERMISSION_MODE_ALIASES = Object.keys(PERMISSION_ALIAS_TO_MODE) as ReadonlyArray<string>

export function parsePermissionModeInput(input: string): PermissionMode | null {
  const trimmed = input.trim().toLowerCase()
  if (!trimmed) return null
  if (trimmed in PERMISSION_ALIAS_TO_MODE) return PERMISSION_ALIAS_TO_MODE[trimmed]!
  for (const mode of PERMISSION_MODES) {
    if (mode.toLowerCase() === trimmed) return mode
  }
  return null
}

export function permissionModeToAlias(mode: PermissionMode): string {
  return PERMISSION_MODE_TO_ALIAS[mode] ?? mode
}

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
  isSubagent: boolean
  signal?: AbortSignal
  permissionApprover?: PermissionApprover
  isBackgroundTask?: boolean
  onPermissionDenial?: (detail: PermissionDenialDetail) => void
}
