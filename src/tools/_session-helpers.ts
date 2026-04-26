import { readdir } from 'node:fs/promises'

import { collectAssistantText } from '../messages.js'
import { resolveSessionsDir } from '../config.js'
import { loadMeta, loadTranscript } from '../session/storage.js'
import type { Message, SessionMeta } from '../types.js'

export type OwnedSession = {
  meta: SessionMeta
  messages: Message[]
}

export async function listOwnedSessions(userId: string): Promise<OwnedSession[]> {
  try {
    const entries = await readdir(resolveSessionsDir(), { withFileTypes: true })
    const sessions = await Promise.all(
      entries
        .filter(entry => entry.isDirectory())
        .map(async entry => {
          const meta = await loadMeta(entry.name)
          if (!meta || meta.userId !== userId) {
            return null
          }
          return {
            meta,
            messages: await loadTranscript(entry.name),
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
  return message.message.content.map(block => block.content).join('\n')
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
  return `[${timestamp}] tool_result: ${message.message.content.map(block => block.content).join('\n')}`
}

