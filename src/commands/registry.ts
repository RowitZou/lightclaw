import type { Interface } from 'node:readline/promises'
import type { Writable } from 'node:stream'

import type { LightClawConfig } from '../config.js'
import type { Tool } from '../tool.js'
import type { Message, UserContentBlock } from '../types.js'

export type CommandVisibility = 'all' | 'admin' | 'user'

export type SlashBodyFormat = 'lark_md' | 'plain_text'

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
  persistMeta(messageCount: number): Promise<void>
  // Channel-only: lets a slash handler request a different body renderer for
  // its output. Default is plain_text (structured help/status with angle
  // brackets that lark_md would eat). LLM-output handlers like /fresh set
  // 'lark_md' so the body renders as a markdown card instead of a plain
  // notice. No-op in terminal mode.
  setSlashBodyFormat?(format: SlashBodyFormat): void
  // Channel-only: the fully-formed user-message content the channel runner
  // built for this turn — already merged with the `[senderName]` prefix,
  // the `<quoted-message>` / `<quoted-message-unavailable>` block, the
  // `[media attachment]` path breadcrumb, and any inline content blocks (image /
  // pdf bytes) that survived the inline encoder. Slash handlers that spawn
  // a sub-session — /fresh — should forward this verbatim so the sub
  // agent receives the same context the main session would have seen
  // (including reply-quoted attachments). Undefined in terminal mode and
  // for fast-path / synthetic slash entries.
  channelUserMessageContent?: string | UserContentBlock[]
}

export type ReplCommandResult = 'continue' | 'exit'

export type ReplCommand = {
  name: string                 // e.g. "/help", "/user"
  usage: string                // e.g. "/mode <default|plan|acceptEdits|bypassPermissions>"
  description: string
  visibleTo?: CommandVisibility
  // Agent-side: one-sentence "when to suggest this command to the user".
  // Empty = command is invisible to ShowSlashCatalog (agent won't suggest).
  agentAdvisory?: string
  // Agent-side: detailed sub-command list / constraints / examples. Empty =
  // ShowSlashCatalog falls back to the one-line `usage` field.
  agentUsage?: string
  // Commands tied to the agent loop / in-flight turn (/branch, /b, /fresh,
  // /stop). They are meaningful only where a query actually runs — the
  // channel — and are dropped from the terminal admin console's registry.
  channelOnly?: boolean
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
      .filter(command => {
        const v = command.visibleTo ?? 'all'
        if (v === 'all') return true
        if (v === 'admin') return isAdmin
        if (v === 'user') return !isAdmin
        return false
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  find(name: string): ReplCommand | undefined {
    return this.commands.get(name)
  }

  bannerLine(isAdmin = true): string {
    return this.list(isAdmin).map(command => command.name).join(' ')
  }

  async dispatch(
    line: string,
    ctx: ReplContext,
    hints?: Record<string, string>,
  ): Promise<ReplCommandResult | undefined> {
    if (!line.startsWith('/')) {
      return undefined
    }

    const spaceIndex = line.indexOf(' ')
    const name = spaceIndex === -1 ? line : line.slice(0, spaceIndex)
    const args = spaceIndex === -1 ? '' : line.slice(spaceIndex + 1).trim()

    const command = this.commands.get(name)
    if (!command) {
      const hint = hints?.[name]
      ctx.output.write(
        hint
          ? `error> unknown command: ${name}. Renamed to ${hint}. See /help.\n`
          : `error> unknown command: ${name}\n`,
      )
      return 'continue'
    }
    const visibility = command.visibleTo ?? 'all'
    if (visibility === 'admin' && !ctx.isAdmin) {
      ctx.output.write(`error> ${name} is admin-only.\n`)
      return 'continue'
    }
    if (visibility === 'user' && ctx.isAdmin) {
      ctx.output.write(`error> ${name} is user-only (admins are the recipient, not the sender).\n`)
      return 'continue'
    }

    const result = await command.handler(args, ctx)
    return result ?? 'continue'
  }
}
