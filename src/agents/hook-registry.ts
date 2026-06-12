import { resolveRolePolicy } from './role-presets.js'
import type { Role } from './types.js'
import { autoCompactHook } from './hooks/auto-compact.js'
import { autoMemoryHook } from './hooks/auto-memory.js'
import { backgroundResultToInterjectionHook } from './hooks/background-result-to-interjection.js'
import { backgroundExecResultToInterjectionHook } from './hooks/background-exec-result-to-interjection.js'
import { chainAbortPropagationHook } from './hooks/chain-abort-propagation.js'
import { deferredToolsHook } from './hooks/deferred-tools.js'
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
  'background-result-to-interjection': backgroundResultToInterjectionHook,
  'background-exec-result-to-interjection': backgroundExecResultToInterjectionHook,
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
