import {
  appendFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'

import { resolveSessionsDir } from '../config.js'
import {
  getCompactionCount,
  getCwd,
  getModel,
  getPermissionMode,
} from '../state.js'
import type { Message, SessionMeta } from '../types.js'
import type { TodoItem } from '../types.js'

function getTranscriptPath(sessionId: string): string {
  return path.join(getSessionDir(sessionId), 'transcript.jsonl')
}

function getMetaPath(sessionId: string): string {
  return path.join(getSessionDir(sessionId), 'meta.json')
}

async function ensureSessionDir(sessionId: string): Promise<string> {
  const sessionDir = getSessionDir(sessionId)
  await mkdir(sessionDir, { recursive: true })
  return sessionDir
}

export function getSessionDir(sessionId: string): string {
  return path.join(resolveSessionsDir(), sessionId)
}

export async function appendMessage(
  sessionId: string,
  message: Message,
): Promise<void> {
  await ensureSessionDir(sessionId)
  await appendFile(
    getTranscriptPath(sessionId),
    `${JSON.stringify(message)}\n`,
    'utf8',
  )
}

export async function loadTranscript(sessionId: string): Promise<Message[]> {
  try {
    const raw = await readFile(getTranscriptPath(sessionId), 'utf8')
    const messages: Message[] = []
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.length === 0) {
        continue
      }

      try {
        messages.push(JSON.parse(trimmed) as Message)
      } catch {
        continue
      }
    }

    return messages
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }

    throw error
  }
}

export async function rewriteTranscript(
  sessionId: string,
  messages: Message[],
): Promise<void> {
  const sessionDir = await ensureSessionDir(sessionId)
  const tempPath = path.join(sessionDir, 'transcript.jsonl.tmp')
  const nextContent =
    messages.length > 0
      ? `${messages.map(message => JSON.stringify(message)).join('\n')}\n`
      : ''

  await writeFile(tempPath, nextContent, 'utf8')
  await rename(tempPath, getTranscriptPath(sessionId))
}

export async function loadMeta(sessionId: string): Promise<SessionMeta | null> {
  try {
    const raw = await readFile(getMetaPath(sessionId), 'utf8')
    return JSON.parse(raw) as SessionMeta
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }

    return null
  }
}

export async function saveMeta(
  sessionId: string,
  meta: SessionMeta,
): Promise<void> {
  await ensureSessionDir(sessionId)
  await writeFile(getMetaPath(sessionId), `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
}

export async function touchMeta(
  sessionId: string,
  messageCount: number,
): Promise<void> {
  const now = Date.now()
  const current = await loadMeta(sessionId)
  await saveMeta(sessionId, {
    sessionId,
    model: current?.model ?? getModel(),
    cwd: current?.cwd ?? getCwd(),
    createdAt: current?.createdAt ?? now,
    lastActiveAt: now,
    messageCount,
    compactionCount: getCompactionCount(),
    lastExtractedAt: current?.lastExtractedAt,
    todos: current?.todos,
    permissionMode: getPermissionMode(),
  })
}

export async function updateMetaLastExtractedAt(
  sessionId: string,
  lastExtractedAt: number,
): Promise<void> {
  const current = await loadMeta(sessionId)
  const now = Date.now()

  await saveMeta(sessionId, {
    sessionId,
    model: current?.model ?? getModel(),
    cwd: current?.cwd ?? getCwd(),
    createdAt: current?.createdAt ?? now,
    lastActiveAt: current?.lastActiveAt ?? now,
    messageCount: current?.messageCount ?? 0,
    compactionCount: current?.compactionCount ?? getCompactionCount(),
    lastExtractedAt,
    todos: current?.todos,
    permissionMode: current?.permissionMode ?? getPermissionMode(),
  })
}

export async function updateMetaTodos(
  sessionId: string,
  todos: TodoItem[],
): Promise<void> {
  const current = await loadMeta(sessionId)
  const now = Date.now()

  await saveMeta(sessionId, {
    sessionId,
    model: current?.model ?? getModel(),
    cwd: current?.cwd ?? getCwd(),
    createdAt: current?.createdAt ?? now,
    lastActiveAt: now,
    messageCount: current?.messageCount ?? 0,
    compactionCount: current?.compactionCount ?? getCompactionCount(),
    lastExtractedAt: current?.lastExtractedAt,
    todos,
    permissionMode: current?.permissionMode ?? getPermissionMode(),
  })
}
