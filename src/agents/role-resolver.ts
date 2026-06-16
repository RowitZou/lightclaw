import { getAgent, getAllAgents } from './registry.js'
import type { Role } from './types.js'

export function normalizeRoleLookupKey(value: string): string {
  return value.trim().toLowerCase().replace(/[-_\s]+/g, '')
}

export function resolveAgentLenient(value: string): Role | null {
  const trimmed = value.trim()
  const exact = getAgent(trimmed)
  if (exact) {
    return exact
  }

  const key = normalizeRoleLookupKey(trimmed)
  if (!key) {
    return null
  }

  return getAllAgents().find(agent => normalizeRoleLookupKey(agent.agentType) === key) ?? null
}
