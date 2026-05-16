import type { Dirent } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

export async function resolveWakeSessionId(
  canonicalUser: string,
  sessionsDir: string,
): Promise<string | null> {
  let entries: Dirent[]
  try {
    entries = await readdir(sessionsDir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
  let best: { sessionId: string; lastActiveAt: number } | null = null
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('feishu:dm:')) {
      continue
    }
    const meta = await readMetaFromDir(sessionsDir, entry.name)
    if (!meta || meta.userId !== canonicalUser) {
      continue
    }
    if (!best || meta.lastActiveAt > best.lastActiveAt) {
      best = { sessionId: entry.name, lastActiveAt: meta.lastActiveAt }
    }
  }
  return best?.sessionId ?? null
}

export async function resolveOriginWakeSessionId(
  originSessionId: string,
  sessionsDir: string,
): Promise<string | null> {
  if (!originSessionId.startsWith('feishu:dm:') && !originSessionId.startsWith('feishu:group:')) {
    return null
  }
  const meta = await readMetaFromDir(sessionsDir, originSessionId)
  return meta ? originSessionId : null
}

async function readMetaFromDir(
  sessionsDir: string,
  sessionId: string,
): Promise<{ userId?: string; lastActiveAt: number } | null> {
  try {
    const raw = await readFile(path.join(sessionsDir, sessionId, 'meta.json'), 'utf8')
    const parsed = JSON.parse(raw) as { userId?: string; lastActiveAt?: number }
    if (typeof parsed.lastActiveAt !== 'number') {
      return null
    }
    return { userId: parsed.userId, lastActiveAt: parsed.lastActiveAt }
  } catch {
    return null
  }
}

