import type { LightClawConfig } from '../config.js'
import type { Tool } from '../tool.js'
import type { Message } from '../types.js'

export type CacheSafeParams = {
  systemPrompt: string
  tools: Tool[]
  forkContextMessages: Message[]
  config: LightClawConfig
}

// Sharded by canonical user. Phase 20 split per-session state into
// AsyncLocalStorage-backed SessionContext but missed this slot — the prior
// module-level `let lastCacheSafeParams` was a single global, so a fork
// dispatched by user A could read user B's most-recent snapshot if B's main
// turn happened to finish first. The bug was invisible because forks (memory
// extraction / autoDream) run async after a turn ends; under multi-user
// dogfood A's MEMORY.md silently absorbed content from B's conversation.
//
// Keying by canonical user is the right grain: extraction / dream are
// per-canonical, sub-LLM cache prefixes naturally align there. If a future
// feature requires per-sessionId isolation (DM vs group prefix divergence),
// upgrade the key without touching call sites.
const lastCacheSafeParamsByUser = new Map<string, CacheSafeParams>()

export function saveCacheSafeParams(
  canonicalUser: string | undefined,
  params: CacheSafeParams | null,
): void {
  if (!canonicalUser) {
    return
  }
  if (params === null) {
    lastCacheSafeParamsByUser.delete(canonicalUser)
    return
  }
  lastCacheSafeParamsByUser.set(canonicalUser, params)
}

export function getLastCacheSafeParams(
  canonicalUser: string | undefined,
): CacheSafeParams | null {
  if (!canonicalUser) {
    return null
  }
  return lastCacheSafeParamsByUser.get(canonicalUser) ?? null
}

export function createCacheSafeParams(args: {
  systemPrompt: string
  tools: Tool[]
  messages: Message[]
  config: LightClawConfig
}): CacheSafeParams {
  return {
    systemPrompt: args.systemPrompt,
    tools: [...args.tools],
    forkContextMessages: [...args.messages],
    config: args.config,
  }
}

/**
 * Test-only escape hatch: drops every per-user snapshot. Production code
 * should never call this — callers should rely on per-canonical scoping
 * to keep their reads / writes isolated.
 */
export function _resetCacheSafeParamsForTest(): void {
  lastCacheSafeParamsByUser.clear()
}
