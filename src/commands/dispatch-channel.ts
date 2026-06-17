import type { Writable } from 'node:stream'

import type { LightClawConfig } from '../config.js'
import type { Tool } from '../tool.js'
import { t } from '../i18n/index.js'
import type { Message, UserContentBlock } from '../types.js'
import { createBuiltinReplRegistry, RENAMED_COMMANDS } from './builtin.js'
import type { ReplContext, SlashBodyFormat } from './registry.js'

export type ChannelSlashResult = {
  handled: boolean
  output: string
  // Defaults to 'plain_text' — the structured /help / /status / /sandbox
  // output contains angle brackets like `<prompt>` that lark_md would parse
  // as HTML tags and silently drop. A handler whose output is genuine markdown
  // opts into 'lark_md' so the runner routes it through the markdown reply
  // path; no built-in handler currently does (the former opt-in /fresh was
  // removed in Phase 9 PR1).
  bodyFormat: SlashBodyFormat
}

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
    // Pre-formatted user message content (text + inline blocks + quote /
    // attachment breadcrumbs). Threaded into ReplContext so a slash handler
    // that needs the full channel turn context can read it instead of just its
    // raw `<args>`. Currently unread: the former consumer /fresh was removed in
    // Phase 9 PR1.
    channelUserMessageContent?: string | UserContentBlock[]
  },
): Promise<ChannelSlashResult> {
  const trimmed = text.trimStart()
  if (!trimmed.startsWith('/')) {
    return { handled: false, output: '', bodyFormat: 'plain_text' }
  }

  const output: string[] = []
  const name = trimmed.split(/\s+/, 1)[0] ?? ''
  const registry = createBuiltinReplRegistry()
  if (!registry.find(name)) {
    const renamed = RENAMED_COMMANDS[name]
    if (renamed) {
      return {
        handled: true,
        output: `${t('common.error.prefix')}${t('common.error.renamedHint', { name, newName: renamed })}\n`,
        bodyFormat: 'plain_text',
      }
    }
    return { handled: false, output: '', bodyFormat: 'plain_text' }
  }

  const writable = {
    write(chunk: string | Buffer) {
      output.push(String(chunk))
      return true
    },
  } as Writable

  let bodyFormat: SlashBodyFormat = 'plain_text'

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
    persistMeta: input.persistMeta,
    setSlashBodyFormat(format: SlashBodyFormat) {
      bodyFormat = format
    },
    channelUserMessageContent: input.channelUserMessageContent,
  }

  const result = await registry.dispatch(trimmed, ctx)
  return {
    handled: result !== undefined,
    output: output.join(''),
    bodyFormat,
  }
}
