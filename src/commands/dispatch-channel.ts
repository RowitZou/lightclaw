import type { Writable } from 'node:stream'

import type { LightClawConfig } from '../config.js'
import type { Tool } from '../tool.js'
import type { Message, UserContentBlock } from '../types.js'
import { createBuiltinReplRegistry } from './builtin.js'
import type { CommandListCardSpec, ReplContext, SlashBodyFormat } from './registry.js'

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
  // When set, the channel renders this as a structured command-list card
  // (column_set) instead of the `output` string; `output` stays the terminal
  // fallback text.
  commandListCard?: CommandListCardSpec
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
    // Materialized inbound attachment paths (sandbox-visible), threaded so a
    // slash handler can ingest a user-supplied file (e.g. `/system data import
    // --feishu`). Omitted for queue-drained / synthetic entries with no fresh
    // attachment.
    attachmentPaths?: string[]
  },
): Promise<ChannelSlashResult> {
  const trimmed = text.trimStart()
  if (!trimmed.startsWith('/')) {
    return { handled: false, output: '', bodyFormat: 'plain_text' }
  }

  const output: string[] = []
  const name = trimmed.split(/\s+/, 1)[0] ?? ''
  const registry = createBuiltinReplRegistry()
  // An unrecognized command is left for the caller to treat as ordinary chat
  // (no legacy rename hints — those were retired). The channel runner routes
  // `handled: false` to the agent loop.
  if (!registry.find(name)) {
    return { handled: false, output: '', bodyFormat: 'plain_text' }
  }

  const writable = {
    write(chunk: string | Buffer) {
      output.push(String(chunk))
      return true
    },
  } as Writable

  let bodyFormat: SlashBodyFormat = 'plain_text'
  let commandListCard: CommandListCardSpec | undefined

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
    setCommandListCard(spec: CommandListCardSpec) {
      commandListCard = spec
    },
    channelUserMessageContent: input.channelUserMessageContent,
    attachmentPaths: input.attachmentPaths,
  }

  const result = await registry.dispatch(trimmed, ctx)
  return {
    handled: result !== undefined,
    output: output.join(''),
    bodyFormat,
    commandListCard,
  }
}
