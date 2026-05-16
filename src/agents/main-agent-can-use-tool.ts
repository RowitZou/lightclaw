import type { CanUseToolFn } from '../tool.js'
import { deriveCanUseTool } from './role-tool-gate.js'
import type { Role } from './types.js'

export type MainAgentToolMode = 'normal' | 'wake'

export function createMainAgentCanUseTool(
  mode: MainAgentToolMode,
  role: Role,
): CanUseToolFn {
  const roleGate = deriveCanUseTool(role)
  return async (tool, input) => {
    void mode
    return await roleGate(tool, input)
  }
}
