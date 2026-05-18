import { resolveRolePolicy } from './role-presets.js'
import type { Role } from './types.js'
import { autoCompactHook } from './hooks/auto-compact.js'
import { autoMemoryHook } from './hooks/auto-memory.js'
import { backgroundResultToInterjectionHook } from './hooks/background-result-to-interjection.js'
import { chainAbortPropagationHook } from './hooks/chain-abort-propagation.js'
import { deferredToolsHook } from './hooks/deferred-tools.js'
import { forwardProgressToChannelHook } from './hooks/forward-progress-to-channel.js'
import { memoryNudgeHook } from './hooks/memory-nudge.js'
import { promptTooLongRetryHook } from './hooks/prompt-too-long-retry.js'
import { splitRenderHook } from './hooks/split-render.js'
import type { Hook } from './hooks/types.js'

export const BUNDLED_HOOKS: Record<string, Hook> = {
  'auto-compact': autoCompactHook,
  'deferred-tools-discovery': deferredToolsHook,
  'split-render': splitRenderHook,
  'prompt-too-long-retry': promptTooLongRetryHook,
  'memory-nudge': memoryNudgeHook,
  'auto-memory-extract': autoMemoryHook,
  'forward-progress-to-channel': forwardProgressToChannelHook,
  'background-result-to-interjection': backgroundResultToInterjectionHook,
  'chain-abort-propagation': chainAbortPropagationHook,
}

export function resolveHooks(role: Role): Hook[] {
  const allowlist = resolveRolePolicy(role).hooks as readonly string[]
  if (allowlist.includes('*')) {
    return Object.values(BUNDLED_HOOKS)
  }

  return allowlist
    .map(name => BUNDLED_HOOKS[name])
    .filter((hook): hook is Hook => hook !== undefined)
}
