import { getConfig, type LightClawConfig } from './config.js'
import { getProvider } from './provider/index.js'
import type { StreamChatParams } from './provider/types.js'
import type { StreamEvent } from './types.js'

export async function* streamChat(
  params: StreamChatParams & { config?: LightClawConfig },
): AsyncGenerator<StreamEvent> {
  const { config: paramConfig, ...rest } = params
  const config = paramConfig ?? getConfig()
  const provider = getProvider(config)
  yield* provider.streamChat(rest)
}
