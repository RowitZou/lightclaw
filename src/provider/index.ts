import type { LightClawConfig } from '../config.js'
import { createAnthropicProvider } from './anthropic.js'
import { createOpenAIProvider } from './openai.js'
import type { Provider } from './types.js'

export type ModelTask = 'main' | 'compact' | 'extract' | 'subagent' | 'webSearch'

let cachedProvider: Provider | null = null
let cachedKey = ''

export function getProvider(config: LightClawConfig): Provider {
  const providerOptions = config.providerOptions[config.provider]
  const key = [
    config.provider,
    providerOptions?.apiKey ?? '',
    providerOptions?.baseUrl ?? '',
  ].join(':')

  if (cachedProvider && cachedKey === key) {
    return cachedProvider
  }

  cachedProvider =
    config.provider === 'openai'
      ? createOpenAIProvider(config)
      : createAnthropicProvider(config)
  cachedKey = key
  return cachedProvider
}

export function modelFor(task: ModelTask, config: LightClawConfig): string {
  return config.routing[task] ?? config.routing.main ?? config.model
}
