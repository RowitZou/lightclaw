import type { CanUseToolFn } from '../tool.js'

export type MainAgentToolMode = 'normal' | 'wake'

const WAKE_ONLY_TOOLS = new Set(['notify_user', 'stay_silent'])

export function createMainAgentCanUseTool(mode: MainAgentToolMode): CanUseToolFn {
  return async tool => {
    if (mode === 'wake') {
      return { behavior: 'allow' }
    }
    if (WAKE_ONLY_TOOLS.has(tool.name)) {
      return {
        behavior: 'deny',
        reason: `${tool.name} is wake-mode only; normal turns send messages through the channel reply path.`,
      }
    }
    return { behavior: 'allow' }
  }
}
