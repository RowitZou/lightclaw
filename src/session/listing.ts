import { readdir } from 'node:fs/promises'

import { resolveSessionsDir } from '../config.js'
import type { SessionMeta } from '../types.js'
import { loadMeta } from './storage.js'

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 16).replace('T', ' ')
}

export async function listSessions(userId?: string): Promise<SessionMeta[]> {
  try {
    const entries = await readdir(resolveSessionsDir(), { withFileTypes: true })
    const sessions = await Promise.all(
      entries
        .filter(entry => entry.isDirectory())
        .map(async entry => loadMeta(entry.name)),
    )

    return sessions
      .filter((session): session is SessionMeta => session !== null)
      .filter(session => !userId || session.userId === userId)
      .sort((left, right) => right.lastActiveAt - left.lastActiveAt)
      .slice(0, 20)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }

    throw error
  }
}

export async function getLatestSessionId(userId?: string): Promise<string | null> {
  const sessions = await listSessions(userId)
  return sessions[0]?.sessionId ?? null
}

export function formatSessionList(sessions: SessionMeta[]): string {
  if (sessions.length === 0) {
    return 'No saved sessions found.\n'
  }

  return `${sessions
    .map(
      (session, index) =>
        `[${index + 1}] ${session.sessionId}  ${formatTimestamp(session.lastActiveAt)}  ${session.messageCount} msgs  ${session.model}`,
    )
    .join('\n')}\n`
}
