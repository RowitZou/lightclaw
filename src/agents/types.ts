export const BUNDLED_AGENT_TYPES = [
  'main',
  'generalist',
  'localExplorer',
  'webSearcher',
  'memoryExtractor',
  'memoryCurator',
  'feishuSecretary',
  'coder',
  'archivist',
  'reviewer',
] as const

export type BundledAgentType = (typeof BUNDLED_AGENT_TYPES)[number]

// Phase 6 will allow user-defined roles on disk. Keep the public type open now
// so later phases add declarations instead of widening the core shape again.
export type AgentType = BundledAgentType | (string & {})

export type RoleKind = 'orchestrator' | 'worker' | 'internal'

export type OutputContract = 'report' | 'side-effect'

export type RoleResourceAllowlist = string[] | ['*']

export type WorkerFailureReason =
  | 'permission-deny'
  | 'tool-unavailable'
  | 'max-turns-exceeded'
  | 'wall-clock-exceeded'
  | 'aborted'
  | 'other'

export type WorkerFailure = {
  status: 'failed'
  reason: WorkerFailureReason
  message: string
  partial_result?: string
  suggested_action?: {
    kind: 'request-permission' | 'retry-with-narrower-scope' | 'ask-user' | 'give-up'
    detail?: string
  }
}

export type Role = {
  // A. Identity and discovery. `agentType` remains the canonical id until the
  // bundled definitions are migrated; `name` is the terminal Role spelling.
  agentType: AgentType
  name?: AgentType
  kind?: RoleKind
  whenToUse: string
  description?: string

  // B. Brain.
  systemPrompt: string

  // C. Resource visibility allowlists.
  tools: RoleResourceAllowlist
  skills?: RoleResourceAllowlist
  mcpServers?: RoleResourceAllowlist
  reachableRoles?: string[]
  hooks?: RoleResourceAllowlist

  // D. Lifecycle and output contract.
  outputContract?: OutputContract
  maxTurns?: number
}
