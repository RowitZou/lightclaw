import { readdir } from 'node:fs/promises'
import { resolveSessionsDir } from '../config.js'
import { userSessionsRoot, usersRoot } from '../identity/paths.js'
import type { SessionMeta } from '../types.js'
import { loadMetaFromDir } from './storage.js'

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 16).replace('T', ' ')
}

export async function listSessions(userId?: string): Promise<SessionMeta[]> {
  const dirs = userId ? [userSessionsRoot(userId)] : await listAllSessionRoots()
  const sessions = (await Promise.all(dirs.map(readSessionsFromRoot))).flat()
  return sessions
    .filter(session => !userId || session.userId === userId)
    .sort((left, right) => right.lastActiveAt - left.lastActiveAt)
    .slice(0, 20)
}

export async function listSessionsTouchedSince(
  userId: string,
  sinceMs: number,
): Promise<string[]> {
  const sessions = await readSessionsFromRoot(userSessionsRoot(userId))
  return sessions
    .filter(session => session.userId === userId && session.lastActiveAt > sinceMs)
    .map(session => session.sessionId)
}

async function readSessionsFromRoot(sessionsDir: string): Promise<SessionMeta[]> {
  try {
    const entries = await readdir(sessionsDir, { withFileTypes: true })
    const sessions = await Promise.all(
      entries
        .filter(entry => entry.isDirectory())
        .map(async entry => loadMetaFromDir(sessionsDir, entry.name)),
    )

    return sessions
      .filter((session): session is SessionMeta => session !== null)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }

    throw error
  }
}

async function listAllSessionRoots(): Promise<string[]> {
  const roots = [resolveSessionsDir()]
  try {
    const users = await readdir(usersRoot(), { withFileTypes: true })
    for (const user of users) {
      if (user.isDirectory()) {
        roots.push(userSessionsRoot(user.name))
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }
  return roots
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
