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

/**
 * Resolve the user-facing chat a bg-result should wake main in. Priority:
 *   1. the dispatch's own origin session (the chat it was created from);
 *   2. the chain root's session — main's ORIGINAL chat for the whole tree;
 *   3. the most-recent active DM (legacy / deleted-origin last resort).
 *
 * Step 2 is what keeps an orphaned worker result in the chat the user is
 * actually in. A grandchild dispatched by a worker carries an
 * `originSessionId` that is its spawner's chain-leaf id (e.g. `alice-ab12cd`),
 * which step 1 rejects as non-Feishu; without the chain-root step it would
 * fall through to the most-recent-DM heuristic and surface a group test's
 * result in a DM (2026-06-14 dogfood).
 */
export async function resolveMainWakeSessionId(input: {
  originSessionId?: string
  chainRootSessionId?: string
  canonicalUser: string
  sessionsDir: string
}): Promise<string | null> {
  if (input.originSessionId) {
    const fromOrigin = await resolveOriginWakeSessionId(input.originSessionId, input.sessionsDir)
    if (fromOrigin) return fromOrigin
  }
  if (input.chainRootSessionId && input.chainRootSessionId !== input.originSessionId) {
    const fromRoot = await resolveOriginWakeSessionId(input.chainRootSessionId, input.sessionsDir)
    if (fromRoot) return fromRoot
  }
  return await resolveWakeSessionId(input.canonicalUser, input.sessionsDir)
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

