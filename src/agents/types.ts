export type AgentType =
  | 'general-purpose'
  | 'explore'
  | 'extract_memories'
  | 'auto_dream'

// user-facing: AgentTool subagents dispatched from the main agent loop.
//   BLOCKED_SUBAGENT_TOOLS applies (no MemoryWrite, no BackgroundTask, no recursive AgentTool).
//   Surfaced to the main agent via AgentTool's `subagent_type` enum.
// internal: framework-managed subagents (memory extraction, autoDream).
//   Bypass BLOCKED_SUBAGENT_TOOLS — they typically need MemoryWrite. The caller
//   supplies its own canUseTool gate. Never surfaced to AgentTool.
export type AgentKind = 'user-facing' | 'internal'

export type AgentDefinition = {
  agentType: AgentType
  whenToUse: string
  tools: string[] | ['*']
  systemPrompt: string
  maxTurns?: number
  // Defaults to 'user-facing' when omitted (back-compat for existing bundled defs).
  kind?: AgentKind
}
