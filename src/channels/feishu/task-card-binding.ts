// Task-card binding sidecar (collab-phase4 PR20).
//
// `<taskrun-dir>/card.json` records which Feishu card message renders a
// root TaskRun. It is UI state, NOT task history — it deliberately does
// not enter events.jsonl. Best-effort on both ends: a corrupt or missing
// file just means the next render creates a fresh card (the old card
// becomes a harmless orphan; V1 does not chase it down).

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

import { taskRunDirPath } from '../../taskrun/store.js'

export type TaskCardBinding = {
  chatId: string
  threadId?: string
  /** Inbound message the card was created as a reply to (topic groups
   *  require the reply path; `im.message.create` cannot target a thread). */
  replyAnchorMessageId?: string
  messageId: string
  /** Set after the terminal "freeze" render; a finalized card is never
   *  patched again. */
  finalizedAt?: number
  /** CardKit card id for live cards created through cardkit.v1.card.create.
   *  Present only when channels.feishu.streamingReply is enabled. */
  cardId?: string
  /** Last CardKit sequence used for this card. Every card.update /
   *  cardElement.content / settings call must increment it. */
  cardSequence?: number
}

function bindingPath(ownerCanonicalUser: string, rootRunId: string): string {
  return path.join(taskRunDirPath(ownerCanonicalUser, rootRunId), 'card.json')
}

export async function readTaskCardBinding(
  ownerCanonicalUser: string,
  rootRunId: string,
): Promise<TaskCardBinding | null> {
  let raw: string
  try {
    raw = await readFile(bindingPath(ownerCanonicalUser, rootRunId), 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as Partial<TaskCardBinding>
    if (typeof parsed.chatId !== 'string' || parsed.chatId.length === 0) return null
    if (typeof parsed.messageId !== 'string' || parsed.messageId.length === 0) return null
    return {
      chatId: parsed.chatId,
      messageId: parsed.messageId,
      ...(typeof parsed.threadId === 'string' ? { threadId: parsed.threadId } : {}),
      ...(typeof parsed.replyAnchorMessageId === 'string'
        ? { replyAnchorMessageId: parsed.replyAnchorMessageId }
        : {}),
      ...(typeof parsed.finalizedAt === 'number' ? { finalizedAt: parsed.finalizedAt } : {}),
      ...(typeof parsed.cardId === 'string' ? { cardId: parsed.cardId } : {}),
      ...(typeof parsed.cardSequence === 'number' ? { cardSequence: parsed.cardSequence } : {}),
    }
  } catch {
    return null
  }
}

/** Best-effort write; returns false (after one stderr line) on failure.
 *  A lost binding only costs one duplicate card on the next render. */
export async function writeTaskCardBinding(
  ownerCanonicalUser: string,
  rootRunId: string,
  binding: TaskCardBinding,
): Promise<boolean> {
  const target = bindingPath(ownerCanonicalUser, rootRunId)
  try {
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, `${JSON.stringify(binding, null, 2)}\n`, 'utf8')
    return true
  } catch (error) {
    process.stderr.write(
      `[task-card] failed to write binding for ${rootRunId}: ${(error as Error).message}\n`,
    )
    return false
  }
}
