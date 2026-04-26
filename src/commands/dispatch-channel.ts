import type { Writable } from 'node:stream'

import type { LightClawConfig } from '../config.js'
import type { Tool } from '../tool.js'
import type { Message } from '../types.js'
import { createBuiltinReplRegistry } from './builtin.js'
import type { ReplContext } from './registry.js'

export async function dispatchChannelSlash(
  text: string,
  input: {
    config: LightClawConfig
    sessionId: string
    createdAt: number
    messages: Message[]
    userId: string
    isAdmin: boolean
    getActiveTools(): Tool[]
    setActiveTools(tools: Tool[]): void
    persistMeta(messageCount: number): Promise<void>
  },
): Promise<{ handled: boolean; output: string }> {
  const trimmed = text.trimStart()
  if (!trimmed.startsWith('/')) {
    return { handled: false, output: '' }
  }

  const output: string[] = []
  const name = trimmed.split(/\s+/, 1)[0] ?? ''
  const registry = createBuiltinReplRegistry()
  if (!registry.find(name)) {
    return { handled: false, output: '' }
  }

  const writable = {
    write(chunk: string | Buffer) {
      output.push(String(chunk))
      return true
    },
  } as Writable

  const ctx: ReplContext = {
    config: input.config,
    sessionId: input.sessionId,
    createdAt: input.createdAt,
    messages: input.messages,
    output: writable,
    userId: input.userId,
    isAdmin: input.isAdmin,
    isChannel: true,
    getActiveTools: input.getActiveTools,
    setActiveTools: input.setActiveTools,
    async runPrompt() {
      output.push('error> command cannot start an interactive prompt from channel mode.\n')
    },
    persistMeta: input.persistMeta,
  }

  const result = await registry.dispatch(trimmed, ctx)
  return {
    handled: result !== undefined,
    output: output.join(''),
  }
}
