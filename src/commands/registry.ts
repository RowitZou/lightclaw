import type { Interface } from 'node:readline/promises'
import type { Writable } from 'node:stream'

import type { LightClawConfig } from '../config.js'
import type { Tool } from '../tool.js'
import type { Message } from '../types.js'

export type ReplContext = {
  config: LightClawConfig
  sessionId: string
  createdAt: number
  messages: Message[]
  rl: Interface
  output: Writable
  getActiveTools(): Tool[]
  setActiveTools(tools: Tool[]): void
  runPrompt(prompt: string, permissionInteractive?: boolean): Promise<void>
  persistMeta(messageCount: number): Promise<void>
}

export type ReplCommandResult = 'continue' | 'exit'

export type ReplCommand = {
  name: string                 // e.g. "/exit", "/mcp"
  usage: string                // e.g. "/mode <default|acceptEdits|bypassPermissions|plan>"
  description: string
  handler(args: string, ctx: ReplContext): Promise<ReplCommandResult | void>
}

export class ReplCommandRegistry {
  private commands = new Map<string, ReplCommand>()

  register(command: ReplCommand): void {
    if (!command.name.startsWith('/')) {
      throw new Error(`Command name must start with "/": ${command.name}`)
    }
    this.commands.set(command.name, command)
  }

  list(): ReplCommand[] {
    return [...this.commands.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  bannerLine(): string {
    return this.list().map(command => command.name).join(' ')
  }

  async dispatch(line: string, ctx: ReplContext): Promise<ReplCommandResult | undefined> {
    if (!line.startsWith('/')) {
      return undefined
    }

    const spaceIndex = line.indexOf(' ')
    const name = spaceIndex === -1 ? line : line.slice(0, spaceIndex)
    const args = spaceIndex === -1 ? '' : line.slice(spaceIndex + 1).trim()

    const command = this.commands.get(name)
    if (!command) {
      ctx.output.write(`error> unknown command: ${name}\n`)
      return 'continue'
    }

    const result = await command.handler(args, ctx)
    return result ?? 'continue'
  }
}
