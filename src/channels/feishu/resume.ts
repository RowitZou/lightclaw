import { readdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

import { getConfig } from '../../config.js'
import { getAdmin, getIdentity } from '../../identity/store.js'
import {
  clearPendingTurn,
  incrementResumeAttempts,
  loadMeta,
  loadTranscript,
  rewriteTranscript,
} from '../../session/storage.js'
import type { Message } from '../../types.js'
import type { NormalizedChannelMessage } from '../types.js'
import { parseFeishuSessionId } from './routing.js'
import { getChannelRunner } from './runner-registry.js'

// A pendingTurn marker older than this is not resumed — the daemon was down
// long enough that the user has almost certainly moved on.
const RESUME_MAX_AGE_MS = 60 * 60 * 1000
// A turn already resumed this many times is abandoned, so a turn that crashes
// the daemon on every resume cannot loop forever across restarts.
const RESUME_MAX_ATTEMPTS = 2

function lastIsAssistantToolUse(messages: Message[]): boolean {
  const last = messages.at(-1)
  return (
    last?.type === 'assistant' &&
    Array.isArray(last.message.content) &&
    last.message.content.some(block => block.type === 'tool_use')
  )
}

/**
 * Startup crash-resume scan. Finds sessions whose transcript carries an
 * in-flight turn marker — set by `handleMessage` and cleared only on
 * in-process completion, so a surviving marker means a hard daemon crash
 * interrupted the turn — and re-enters the agent loop on the persisted
 * partial transcript (PR-A's incremental persistence is what makes that
 * transcript a usable continuation point).
 *
 * Resume reuses the normal channel path: it synthesizes a `resumeExisting`
 * message and feeds it to `handleMessage`, which skips appending a new user
 * message and runs `query()` directly on the loaded transcript.
 *
 * Best-effort: one bad session never blocks the others, and the scan never
 * throws. Fire-and-forget from cli.ts once the channels are up.
 */
export async function resumePendingTurns(): Promise<void> {
  const config = getConfig()
  let sessionIds: string[]
  try {
    const dirents = await readdir(config.paths.sessions, { withFileTypes: true })
    sessionIds = dirents.filter(d => d.isDirectory()).map(d => d.name)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      process.stderr.write(
        `[crash-resume] could not scan sessions dir: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      )
    }
    return
  }

  const adminId = await getAdmin()
  for (const sessionId of sessionIds) {
    try {
      await resumeOneSession(sessionId, config.runtime.backend, adminId)
    } catch (error) {
      process.stderr.write(
        `[crash-resume] ${sessionId}: resume failed: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      )
    }
  }
}

async function resumeOneSession(
  sessionId: string,
  runtimeBackend: string,
  adminId: string | null,
): Promise<void> {
  // Only Feishu main-channel sessions are resumable; bg-* fires,
  // dispatched-* workers, and terminal-console are not (parse returns null).
  const parsed = parseFeishuSessionId(sessionId)
  if (!parsed) {
    return
  }
  const meta = await loadMeta(sessionId)
  if (!meta?.pendingTurn) {
    return
  }

  const { startedAt, resumeAttempts } = meta.pendingTurn
  if (Date.now() - startedAt > RESUME_MAX_AGE_MS) {
    process.stderr.write(`[crash-resume] ${sessionId}: marker too old, skipping\n`)
    await clearPendingTurn(sessionId)
    return
  }
  if (resumeAttempts >= RESUME_MAX_ATTEMPTS) {
    process.stderr.write(
      `[crash-resume] ${sessionId}: gave up after ${resumeAttempts} attempt(s)\n`,
    )
    await clearPendingTurn(sessionId)
    return
  }
  if (!meta.userId) {
    await clearPendingTurn(sessionId)
    return
  }
  // LocalRuntime is admin-only — a non-admin resume would re-enter the admin
  // runtime through the synthetic turn. Mirror the bg-fire / scheduler guard.
  if (runtimeBackend === 'local' && adminId && meta.userId !== adminId) {
    await clearPendingTurn(sessionId)
    return
  }

  // A hard crash between PR-A's two appendFile calls for a [assistant,
  // tool_result-user] pair can leave a trailing orphan assistant tool_use.
  // Drop it so the transcript ends on a coherent user message.
  let messages = await loadTranscript(sessionId)
  const originalLength = messages.length
  while (lastIsAssistantToolUse(messages)) {
    messages = messages.slice(0, -1)
  }
  if (messages.length === 0) {
    await clearPendingTurn(sessionId)
    return
  }
  if (messages.at(-1)?.type === 'assistant') {
    // Ends with a completed assistant turn (no tool_use): the turn actually
    // finished and the crash landed in the tiny window after query()
    // returned but before the marker cleared. Nothing to resume.
    await clearPendingTurn(sessionId)
    return
  }
  if (messages.length !== originalLength) {
    await rewriteTranscript(sessionId, messages)
  }

  // Resolve the user's Feishu open_id so handleMessage's resolveMessageUser
  // maps the synthetic message back to the paired identity (a wrong / missing
  // open_id would drop it into the pairing-card path). Group session ids
  // encode the sender directly; DM ids do not, so go through the identity.
  const senderOpenId =
    parsed.kind === 'group'
      ? parsed.senderOpenId
      : (await getIdentity(meta.userId))?.channels?.feishu?.[0]
  if (!senderOpenId) {
    process.stderr.write(
      `[crash-resume] ${sessionId}: no Feishu open_id for ${meta.userId}, skipping\n`,
    )
    await clearPendingTurn(sessionId)
    return
  }

  const runner = getChannelRunner()
  if (!runner) {
    // Leave the marker set — a later restart with a registered runner can
    // still resume this turn.
    process.stderr.write(
      `[crash-resume] ${sessionId}: no channel runner registered, deferring\n`,
    )
    return
  }

  const attempt = await incrementResumeAttempts(sessionId)
  process.stderr.write(`[crash-resume] ${sessionId}: resuming (attempt ${attempt})\n`)

  const synthetic: NormalizedChannelMessage = {
    channel: 'feishu',
    eventId: `resume-${randomUUID()}`,
    messageId: `resume-${randomUUID()}`,
    chatId: parsed.chatId,
    chatType: parsed.kind === 'dm' ? 'p2p' : 'group',
    ...(parsed.kind === 'group' && parsed.threadId
      ? { threadId: parsed.threadId }
      : {}),
    senderOpenId,
    text: '',
    synthetic: true,
    resumeExisting: true,
  }
  await runner.handleMessage(synthetic)
}
