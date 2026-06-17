import { readdir } from 'node:fs/promises'
import path from 'node:path'

import { collectAssistantText } from '../messages.js'
import { userSessionsRoot } from '../identity/paths.js'
import { loadMetaFromDir, loadTranscriptFile } from '../session/storage.js'
import { toolResultContentToText, type Message, type SessionMeta } from '../types.js'

export type OwnedSession = {
  meta: SessionMeta
  messages: Message[]
}

export async function listOwnedSessions(userId: string): Promise<OwnedSession[]> {
  const sessionsDir = userSessionsRoot(userId)
  try {
    const entries = await readdir(sessionsDir, { withFileTypes: true })
    const sessions = await Promise.all(
      entries
        .filter(entry => entry.isDirectory())
        .map(async entry => {
          const meta = await loadMetaFromDir(sessionsDir, entry.name)
          if (!meta || meta.userId !== userId) {
            return null
          }
          return {
            meta,
            messages: await loadTranscriptFile(path.join(sessionsDir, entry.name, 'transcript.jsonl')),
          }
        }),
    )
    return sessions
      .filter((session): session is OwnedSession => session !== null)
      .sort((left, right) => right.meta.lastActiveAt - left.meta.lastActiveAt)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw error
  }
}

export function channelFromSessionId(sessionId: string): string {
  const index = sessionId.indexOf('-')
  return index > 0 ? sessionId.slice(0, index) : 'terminal'
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
