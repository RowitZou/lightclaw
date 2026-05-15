import type { MemoryType } from '../memory/types.js'

export const BUNDLED_AGENT_TYPES = [
  'general-purpose',
  'explore',
  'extract_memories',
  'auto_dream',
] as const

export type BundledAgentType = (typeof BUNDLED_AGENT_TYPES)[number]

// Phase 6 will allow user-defined roles on disk. Keep the public type open now
// so later phases add declarations instead of widening the core shape again.
export type AgentType = BundledAgentType | (string & {})

export type RoleKind = 'orchestrator' | 'worker' | 'internal'

// Back-compat for pre-Role bundled definitions. Iter 1.3 migrates existing
// 'user-facing' entries to 'worker'; keep accepting it until cleanup.
export type LegacyAgentKind = 'user-facing'
export type AgentKind = RoleKind | LegacyAgentKind

export type OutputContract = 'report' | 'side-effect'

export type RoleResourceAllowlist = string[] | ['*']

export type ContextPolicy = {
  environmentInfo: boolean
  projectMemory: boolean
  autoMemoryIndex: boolean
  memoryRecall: false | { types?: MemoryType[]; topN?: number }
  sessionWorkingMemory: boolean
  skillCatalog: boolean
  permissionSection: boolean
  mcpSection: boolean
  todos: boolean
  channelContext: boolean
  transcriptInheritance: 'none' | 'fork-prefix' | 'full'
  autoCompact: boolean
  autoMemoryExtract: boolean
  deferredToolDiscovery: boolean
  cacheStable: boolean
}

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
  kind?: AgentKind
  whenToUse: string
  description?: string

  // B. Brain.
  systemPrompt: string
  model?: string

  // C. Context assembly policy.
  contextPolicy?: Partial<ContextPolicy>

  // D. Resource visibility allowlists.
  tools: RoleResourceAllowlist
  skills?: RoleResourceAllowlist
  mcpServers?: RoleResourceAllowlist
  reachableRoles?: string[]
  hooks?: RoleResourceAllowlist

  // E. Lifecycle and output contract.
  outputContract?: OutputContract
  maxTurns?: number
  budget?: {
    maxTokens?: number
    maxCost?: number
  }
}

/** @deprecated use Role */
export type AgentDefinition = Role
