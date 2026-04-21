import { BUNDLED_AGENTS } from './bundled/index.js'
import type { AgentDefinition, AgentType } from './types.js'

const registry = new Map<AgentType, AgentDefinition>()

export function registerAgent(definition: AgentDefinition): void {
  registry.set(definition.agentType, definition)
}

export function initializeAgents(): void {
  if (registry.size > 0) {
    return
  }

  for (const agent of BUNDLED_AGENTS) {
    registerAgent(agent)
  }
}

export function getAgent(type: AgentType): AgentDefinition | undefined {
  initializeAgents()
  return registry.get(type)
}

export function getAllAgents(): AgentDefinition[] {
  initializeAgents()
  return [...registry.values()]
}
