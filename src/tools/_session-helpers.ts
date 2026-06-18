import { createReadStream } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { createInterface } from 'node:readline'

import { collectAssistantText } from '../messages.js'
import { parseFeishuSessionId } from '../channels/feishu/routing.js'
import { resolveSessionsDir } from '../config.js'
import {
  getTranscriptPath,
  loadMeta,
  parseTranscriptLine,
} from '../session/storage.js'
import { toolResultContentToText, type Message, type SessionMeta } from '../types.js'

/**
 * True only for sessions that are an actual user conversation — a Feishu DM /
 * group / topic thread, or a terminal console session. The sessions directory
 * also holds framework execution sessions that carry the same `userId`:
 * background fires (`bg-…`) and dispatched-worker leaf sessions (named by raw
 * dispatchId, e.g. `<canonical>-<hex>`). Those are internal plumbing, not
 * conversations the user ever "had", so the Conversation* tools must exclude
 * them. Allowlisting the real shapes (rather than denylisting known ephemeral
 * prefixes) is robust against future internal session-id shapes.
 */
export function isConversationSessionId(sessionId: string): boolean {
  return (
    parseFeishuSessionId(sessionId) !== null ||
    sessionId === 'terminal-console' ||
    sessionId.startsWith('terminal-')
  )
}

/**
 * Enumerate the current user's session metadata, newest-active first. Reads
 * only each session's small `meta.json` — never the transcript — so callers
 * that only need session-level facts (id, channel, last-active, message
 * count) don't materialize every transcript into the heap. Content search is
 * `searchOwnedSessions`, which streams.
 */
export async function listOwnedSessionMetas(userId: string): Promise<SessionMeta[]> {
  try {
    const entries = await readdir(resolveSessionsDir(), { withFileTypes: true })
    const metas = await Promise.all(
      entries
        .filter(entry => entry.isDirectory())
        .filter(entry => isConversationSessionId(entry.name))
        .map(async entry => {
          const meta = await loadMeta(entry.name)
          return meta && meta.userId === userId ? meta : null
        }),
    )
    return metas
      .filter((meta): meta is SessionMeta => meta !== null)
      .sort((left, right) => right.lastActiveAt - left.lastActiveAt)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw error
  }
}

export type SearchOwnedSessionsOptions = {
  query: string
  channel?: string
  daysBack?: number
  /** Stop after this many matching lines have been collected. */
  limit: number
}

/**
 * Full-text search the current user's transcripts, streaming each one line by
 * line so memory stays bounded to a single line + the (capped) result list —
 * no matter how large any single transcript is or how many sessions the user
 * owns. Matches the legacy substring semantics exactly: it searches the same
 * flattened `messageToSearchText` per message (not raw JSONL bytes), counts
 * the same message index `loadTranscript` would (via the shared
 * `parseTranscriptLine`), and is case-insensitive + CJK-correct. Returns
 * formatted `sessionId:index: snippet` lines.
 */
export async function searchOwnedSessions(
  userId: string,
  options: SearchOwnedSessionsOptions,
): Promise<string[]> {
  const needle = options.query.toLowerCase()
  const cutoff = options.daysBack
    ? Date.now() - options.daysBack * 24 * 60 * 60 * 1000
    : 0
  const lines: string[] = []

  for (const meta of await listOwnedSessionMetas(userId)) {
    if (options.channel && channelFromSessionId(meta.sessionId) !== options.channel) {
      continue
    }
    if (meta.lastActiveAt < cutoff) {
      continue
    }

    const stream = createReadStream(getTranscriptPath(meta.sessionId), 'utf8')
    const reader = createInterface({ input: stream, crlfDelay: Infinity })
    let index = 0
    try {
      for await (const line of reader) {
        const message = parseTranscriptLine(line)
        if (message === null) {
          continue
        }
        const text = messageToSearchText(message)
        if (text.toLowerCase().includes(needle)) {
          lines.push(
            `${meta.sessionId}:${index}: ${text.replace(/\s+/g, ' ').slice(0, 240)}`,
          )
          if (lines.length >= options.limit) {
            return lines
          }
        }
        index++
      }
    } catch (error) {
      // A session with a meta.json but no transcript yet — skip it. Any other
      // IO error is real and should surface.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    } finally {
      reader.close()
      stream.destroy()
    }
  }

  return lines
}

export function channelFromSessionId(sessionId: string): string {
  // Phase 26 sessionIds are colon-scheme (`feishu:dm:<chatId>` /
  // `feishu:group:…`); the chat id itself has no scheme-level `-`, so the old
  // split-on-`-` mislabeled every Feishu session as `terminal`. Prefer the
  // scheme prefix before the first `:`, then fall back to the pre-`-` token
  // (terminal sessions), then `terminal`.
  const colon = sessionId.indexOf(':')
  if (colon > 0) {
    return sessionId.slice(0, colon)
  }
  const dash = sessionId.indexOf('-')
  return dash > 0 ? sessionId.slice(0, dash) : 'terminal'
}

export function messageToSearchText(message: Message): string {
  if (message.type === 'system') {
    return message.message.summary
  }
  if (message.type === 'assistant') {
    return collectAssistantText(message.message.content)
  }
  if (typeof message.message.content === 'string') {
    return message.message.content
  }
  return message.message.content
    .map(block => {
      if (block.type === 'text') return block.text
      if (block.type === 'tool_result') return toolResultContentToText(block.content)
      if (block.type === 'image') return `[image: ${block.source.mediaType}]`
      if (block.type === 'document') return `[document: ${block.source.mediaType}]`
      return ''
    })
    .join('\n')
}

export function simplifyMessage(message: Message): string {
  const timestamp = new Date(message.timestamp).toISOString()
  if (message.type === 'assistant') {
    return `[${timestamp}] assistant: ${collectAssistantText(message.message.content) || '[tool use]'}`
  }
  if (message.type === 'system') {
    return `[${timestamp}] system: ${message.message.summary}`
  }
  if (typeof message.message.content === 'string') {
    return `[${timestamp}] user: ${message.message.content}`
  }
  const rendered = message.message.content
    .map(block => {
      if (block.type === 'text') return block.text
      if (block.type === 'tool_result') return toolResultContentToText(block.content)
      if (block.type === 'image') return `[image: ${block.source.mediaType}]`
      if (block.type === 'document') return `[document: ${block.source.mediaType}]`
      return ''
    })
    .join('\n')
  return `[${timestamp}] user: ${rendered}`
}

