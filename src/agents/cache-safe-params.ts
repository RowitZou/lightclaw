import type { LightClawConfig } from '../config.js'
import type { Tool } from '../tool.js'
import type { Message } from '../types.js'

export type CacheSafeParams = {
  systemPrompt: string
  tools: Tool[]
  forkContextMessages: Message[]
  config: LightClawConfig
}

let lastCacheSafeParams: CacheSafeParams | null = null

export function saveCacheSafeParams(params: CacheSafeParams | null): void {
  lastCacheSafeParams = params
}

export function getLastCacheSafeParams(): CacheSafeParams | null {
  return lastCacheSafeParams
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
