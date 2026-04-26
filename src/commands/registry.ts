import type { Interface } from 'node:readline/promises'
import type { Writable } from 'node:stream'

import type { LightClawConfig } from '../config.js'
import type { Tool } from '../tool.js'
import type { Message } from '../types.js'

export type CommandVisibility = 'all' | 'admin'

export type ReplContext = {
  config: LightClawConfig
  sessionId: string
  createdAt: number
  messages: Message[]
  rl?: Interface
  output: Writable
  userId?: string
  isAdmin?: boolean
  isChannel?: boolean
  getActiveTools(): Tool[]
  setActiveTools(tools: Tool[]): void
  runPrompt(prompt: string, permissionInteractive?: boolean): Promise<void>
  persistMeta(messageCount: number): Promise<void>
}

export type ReplCommandResult = 'continue' | 'exit'

export type ReplCommand = {
  name: string                 // e.g. "/help", "/identity"
  usage: string                // e.g. "/mode <default|plan|acceptEdits|bypassPermissions>"
  description: string
  visibleTo?: CommandVisibility
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

  list(isAdmin = true): ReplCommand[] {
    return [...this.commands.values()]
      .filter(command => isAdmin || (command.visibleTo ?? 'all') === 'all')
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  find(name: string): ReplCommand | undefined {
    return this.commands.get(name)
  }

  bannerLine(isAdmin = true): string {
    return this.list(isAdmin).map(command => command.name).join(' ')
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
    if ((command.visibleTo ?? 'all') === 'admin' && !ctx.isAdmin) {
      ctx.output.write('error> admin only.\n')
      return 'continue'
    }

    const result = await command.handler(args, ctx)
    return result ?? 'continue'
  }
}
