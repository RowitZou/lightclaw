import type { LightClawConfig } from '../config.js'
import type { Tool } from '../tool.js'

export type DeferredLoadingMode = 'auto' | 'always' | 'off'

export function shouldEnableDeferredLoading(
  config: LightClawConfig,
  toolsInChannel: readonly Tool[],
): boolean {
  const mode = config.tools.deferredLoading
  if (mode === 'off') return false
  if (mode === 'always') return true
  return toolsInChannel.length >= config.tools.deferredLoadingThreshold
}
