export type AgentType = 'general-purpose' | 'explore'

export type AgentDefinition = {
  agentType: AgentType
  whenToUse: string
  tools: string[] | ['*']
  systemPrompt: string
  maxTurns: number
}
