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
  getCurrentUserId,
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

/**
 * Append a batch of messages to the transcript in a single `appendFile`
 * write. The single syscall is the point: appending message-by-message
 * leaves a window where a process kill between two writes ends the
 * transcript on an orphan `assistant` tool_use whose `tool_result` never
 * reached disk — which fails the next resume with a provider 400. One write
 * makes the batch land all-or-nothing with respect to a kill. A no-op when
 * `messages` is empty (no dir is created).
 */
export async function appendMessages(
  sessionId: string,
  messages: Message[],
): Promise<void> {
  if (messages.length === 0) {
    return
  }
  await ensureSessionDir(sessionId)
  await appendFile(
    getTranscriptPath(sessionId),
    messages.map(message => `${JSON.stringify(message)}\n`).join(''),
    'utf8',
  )
}

export async function appendMessage(
  sessionId: string,
  message: Message,
): Promise<void> {
  await appendMessages(sessionId, [message])
}

export async function loadTranscript(sessionId: string): Promise<Message[]> {
  return loadTranscriptFile(getTranscriptPath(sessionId))
}

export async function loadTranscriptFile(filePath: string): Promise<Message[]> {
  try {
    const raw = await readFile(filePath, 'utf8')
    const messages: Message[] = []
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.length === 0) {
        continue
      }

      try {
        const message = JSON.parse(trimmed) as Message
        // Skip non-Message JSONL lines (e.g. fork transcript meta markers
        // written by fork-transcript.ts:persistForkTranscript). The marker
        // shape is `{kind:'fork-transcript-meta',...}` and has no `type`
        // field, so it would otherwise leak into the messages array as a
        // malformed entry and crash downstream consumers (messageToText,
        // compact, etc.). loadTranscriptFile is shared between fork
        // transcripts (parseForkTranscriptFile honors the marker) and main
        // transcripts (no marker), so the guard is defense-in-depth.
        if (
          message === null ||
          typeof message !== 'object' ||
          (message.type !== 'user' &&
            message.type !== 'assistant' &&
            message.type !== 'system')
        ) {
          continue
        }
        // Skip degenerate empty-content assistant messages persisted by an
        // older build (or a future provider hiccup that slipped through):
        // Anthropic 400s when the conversation history contains an assistant
        // turn with content: [], which then cascades into every subsequent
        // turn returning empty too. Dropping them is safe — they carry no
        // information and the user-facing turn count is unchanged.
        if (
          message.type === 'assistant' &&
          Array.isArray(message.message.content) &&
          message.message.content.length === 0
        ) {
          continue
        }
        messages.push(message)
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
    sessionMemoryUpdatedAt: current?.sessionMemoryUpdatedAt,
    todos: current?.todos,
    permissionMode: getPermissionMode(),
    userId: current?.userId ?? getCurrentUserId(),
    pendingTurn: current?.pendingTurn,
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
    sessionMemoryUpdatedAt: current?.sessionMemoryUpdatedAt,
    todos: current?.todos,
    permissionMode: current?.permissionMode ?? getPermissionMode(),
    userId: current?.userId ?? getCurrentUserId(),
    pendingTurn: current?.pendingTurn,
  })
}

export async function updateMetaSessionMemoryAt(
  sessionId: string,
  sessionMemoryUpdatedAt: number,
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
    lastExtractedAt: current?.lastExtractedAt,
    sessionMemoryUpdatedAt,
    todos: current?.todos,
    permissionMode: current?.permissionMode ?? getPermissionMode(),
    userId: current?.userId ?? getCurrentUserId(),
    pendingTurn: current?.pendingTurn,
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
    sessionMemoryUpdatedAt: current?.sessionMemoryUpdatedAt,
    todos,
    permissionMode: current?.permissionMode ?? getPermissionMode(),
    userId: current?.userId ?? getCurrentUserId(),
    pendingTurn: current?.pendingTurn,
  })
}

/**
 * Mark this session as having a turn in flight. The marker survives a hard
 * daemon crash — it is only cleared by `clearPendingTurn` on in-process
 * completion — so the startup crash-resume scan can find interrupted turns.
 * `resumeAttempts` carries across the crash; markPendingTurn preserves the
 * existing count and only refreshes `startedAt`.
 */
export async function markPendingTurn(sessionId: string): Promise<void> {
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
    lastExtractedAt: current?.lastExtractedAt,
    sessionMemoryUpdatedAt: current?.sessionMemoryUpdatedAt,
    todos: current?.todos,
    permissionMode: current?.permissionMode ?? getPermissionMode(),
    userId: current?.userId ?? getCurrentUserId(),
    pendingTurn: {
      startedAt: now,
      resumeAttempts: current?.pendingTurn?.resumeAttempts ?? 0,
    },
  })
}

/**
 * Clear the pendingTurn marker — called when a turn finishes in-process
 * (success or handled failure). A hard crash leaves the marker set. No-op
 * when there is no marker (e.g. a slash-only message, or no meta yet).
 */
export async function clearPendingTurn(sessionId: string): Promise<void> {
  const current = await loadMeta(sessionId)
  if (!current?.pendingTurn) {
    return
  }
  await saveMeta(sessionId, { ...current, pendingTurn: undefined })
}

/**
 * Bump the crash-resume attempt counter on the pendingTurn marker and return
 * the new value. The resume scan calls this before each resume so a turn that
 * crashes the daemon on every resume cannot loop forever. Returns 0 when
 * there is no marker.
 */
export async function incrementResumeAttempts(sessionId: string): Promise<number> {
  const current = await loadMeta(sessionId)
  if (!current?.pendingTurn) {
    return 0
  }
  const next = current.pendingTurn.resumeAttempts + 1
  await saveMeta(sessionId, {
    ...current,
    pendingTurn: { ...current.pendingTurn, resumeAttempts: next },
  })
  return next
}
