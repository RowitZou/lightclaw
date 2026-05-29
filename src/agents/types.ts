export const BUNDLED_AGENT_TYPES = [
  'main',
  'generalist',
  'localExplorer',
  'webSearcher',
  'memoryExtractor',
  'memoryCurator',
  'skillCurator',
  'skillConsolidator',
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

  // E. User-facing display name in active-verb form ("正在搜索互联网"). Used by
  // the progress / worker-activity breadcrumb path. Optional — bundled workers
  // fill it; user-defined roles may omit it and fall back to a generic label.
  // Never use this in prompt body — the role's own systemPrompt is the source
  // of identity for the model; displayName is purely surface text for the user.
  displayName?: { cn: string; en: string }

  // F. Declarative traits for the shared operating-discipline fragment registry
  // (`src/prompt.ts`). Optional self-declared booleans a role asserts about
  // itself; fragment `when` conditions read these for distinctions that tool /
  // kind cannot express — e.g. `authorsCode` gates the Code style / Publishing
  // fragments (coder / generalist set it; archivist with the same Write/Edit
  // surface does not, because "Don't create *.md" conflicts with its
  // index-authoring job). A user-defined role opts into capability-orthogonal
  // fragments purely by declaring a trait, never by editing fragment text.
  traits?: Record<string, boolean>

  // G. Per-fragment include / exclude override on top of the default `when`
  // conditions, keyed by fragment id. Escape hatch for an operator (or a future
  // main-driven role author) to force a specific shared fragment on or off
  // regardless of its condition. Default conditions cover the common case; this
  // is the surgical override.
  sections?: { include?: string[]; exclude?: string[] }
}
