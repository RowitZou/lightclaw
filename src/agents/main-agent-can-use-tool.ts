import type { CanUseToolFn } from '../tool.js'
import { deriveCanUseTool } from './role-tool-gate.js'
import type { Role } from './types.js'

export type MainAgentToolMode = 'normal' | 'wake'

const WAKE_ONLY_TOOLS = new Set(['notify_user', 'stay_silent'])

export function createMainAgentCanUseTool(
  mode: MainAgentToolMode,
  role: Role,
): CanUseToolFn {
  const roleGate = deriveCanUseTool(role)
  return async (tool, input) => {
    if (mode === 'wake' && WAKE_ONLY_TOOLS.has(tool.name)) {
      return { behavior: 'allow' }
    }
    if (WAKE_ONLY_TOOLS.has(tool.name)) {
      return {
        behavior: 'deny',
        reason: `${tool.name} is wake-mode only; normal turns send messages through the channel reply path.`,
      }
    }
    return await roleGate(tool, input)
  }
}
