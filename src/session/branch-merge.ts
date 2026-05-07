import { existsSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'

import { t } from '../i18n/index.js'
import { createAssistantMessage, createUserMessage } from '../messages.js'
import type {
  BranchPlaceholderMeta,
  BranchSpawnMeta,
  Message,
} from '../types.js'
import { channelSessionLock } from '../channels/session-lock.js'
import {
  appendMessage,
  getSessionDir,
  loadTranscript,
  rewriteTranscript,
} from './storage.js'

export type BranchOutcome =
  | { kind: 'success'; finalText: string }
  | { kind: 'failure'; reason: string }

/**
 * Trim a snapshot of the main transcript to the last stable boundary so a
 * branch session can safely append its own user query and the LLM sees a
 * clean "last completed turn → new user query" structure.
 *
 * Without this, when `/branch` fires while the main turn is still in flight,
 * `loadTranscript(mainSessionId)` returns the user's in-progress query that
 * has not yet received any assistant response. The branch then appends its
 * own user query right after, producing two consecutive user messages.
 * Lenient providers (gpt-5-codex among them) tolerate this by treating the
 * pair as a batch and answering BOTH — so the branch ends up solving the
 * main session's question alongside its own. (See `feishu-zouyicheng` /
 * `branch-zouyicheng-5fce2af1` 2026-05-07 incident — branch's TodoWrite
 * carried both deepseek and glm todos.)
 *
 * The trimmed snapshot also keeps branch transcripts compact, which in
 * turn keeps the branch's auto-memory extraction fast (extraction blocks
 * `awaitBackgroundTasks` at the end of the branch's runner block, and on
 * a 60-message inherited transcript it can outlast the next main turn —
 * the visible "branch done last in tmux" symptom from the same incident).
 *
 * Stable boundaries (walked backwards from the end):
 *   - an `assistant` message that contains NO `tool_use` block (the agent
 *     ended its turn with text / thinking only — nothing pending);
 *   - a `system` compact_boundary message (compact already collapsed the
 *     prefix into a summary; nothing dangling).
 *
 * If no stable boundary exists, returns `[]` — branch then sees only its
 * own user query, which is a clean fresh-context start (no protocol
 * violation). This happens at most on a session whose very first user
 * message is the one that's mid-flight.
 */
export function trimToLastCompletedTurn(messages: Message[]): Message[] {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]
    if (m.type === 'system') {
      return messages.slice(0, i + 1)
    }
    if (m.type === 'assistant') {
      const content = m.message.content
      const hasToolUse = Array.isArray(content)
        && content.some(block => block.type === 'tool_use')
      if (!hasToolUse) {
        return messages.slice(0, i + 1)
      }
    }
  }
  return []
}

export async function appendBranchSpawnPair(input: {
  mainSessionId: string
  userQuery: string
  meta: BranchPlaceholderMeta
}): Promise<void> {
  await channelSessionLock.runExclusive(input.mainSessionId, async () => {
    const spawn: BranchSpawnMeta = {
      branchId: input.meta.branchId,
      branchSessionId: input.meta.branchSessionId,
    }
    const existing = await loadTranscript(input.mainSessionId)
    const user = {
      ...createUserMessage(input.userQuery, lastUuid(existing)),
      branchSpawn: spawn,
    }
    const assistant = {
      ...createAssistantMessage({
        content: [{ type: 'text', text: branchPlaceholderText(input.meta) }],
        stopReason: 'branch_placeholder',
        usage: {},
        parentUuid: user.uuid,
      }),
      branchPlaceholder: input.meta,
    }
    await appendMessage(input.mainSessionId, user)
    await appendMessage(input.mainSessionId, assistant)
  })
}

export type MergeBranchResult =
  | { kind: 'replaced' }
  | { kind: 'fallback-appended' }
  | { kind: 'skipped' }

export async function mergeBranchResultBack(input: {
  mainSessionId: string
  branchId: string
  outcome: BranchOutcome
  /**
   * Optional fallback context. When provided, if the placeholder cannot
   * be located in the main transcript (typical cause: auto-compact ran
   * between spawn and merge-back, compressing the placeholder into a
   * `system` summary message that no longer carries `branchPlaceholder`
   * metadata), we append a synthetic (user, assistant) pair at the end
   * of the transcript instead of silently dropping the result. The pair
   * carries the same `branchSpawn` / `branchPlaceholder` metadata as
   * the in-place replacement would have, with `status: 'completed' |
   * 'failed'`, so main agent's next turn sees the branch outcome as a
   * normal Q+A pair.
   *
   * Without `fallback`, a missing placeholder is silently treated as
   * `'skipped'` (kept for unit tests and any caller that genuinely
   * doesn't want the synthetic append).
   */
  fallback?: {
    userQuery: string
    branchSessionId: string
    startedAt: string
  }
}): Promise<MergeBranchResult> {
  return channelSessionLock.runExclusive(input.mainSessionId, async () => {
    const messages = await loadTranscript(input.mainSessionId)
    let changed = false
    const next = messages.map(message => {
      if (
        message.type !== 'assistant' ||
        message.branchPlaceholder?.branchId !== input.branchId
      ) {
        return message
      }
      changed = true
      const status = input.outcome.kind === 'success' ? 'completed' : 'failed'
      const meta: BranchPlaceholderMeta = {
        ...message.branchPlaceholder,
        status,
        completedAt: new Date().toISOString(),
      }
      return {
        ...message,
        branchPlaceholder: meta,
        message: {
          ...message.message,
          content: [{
            type: 'text',
            text: input.outcome.kind === 'success'
              ? input.outcome.finalText
              : branchPlaceholderText(meta, input.outcome.reason),
          }],
        },
      } satisfies Message
    })
    if (changed) {
      await rewriteTranscript(input.mainSessionId, next)
      return { kind: 'replaced' }
    }

    if (!input.fallback) {
      process.stderr.write(
        `branch ${input.branchId} merge-back skipped: placeholder not found in ${input.mainSessionId} (no fallback provided)\n`,
      )
      return { kind: 'skipped' }
    }

    // Placeholder is gone (likely compacted). Append a synthetic
    // (user, assistant) pair at the end so main agent still sees the
    // branch outcome on its next turn. The metadata (branchSpawn /
    // branchPlaceholder with status='completed'|'failed' + completedAt)
    // matches what an in-place replacement would have, so transcript
    // readers cannot tell the difference structurally.
    const completedAt = new Date().toISOString()
    const status = input.outcome.kind === 'success' ? 'completed' : 'failed'
    const meta: BranchPlaceholderMeta = {
      branchId: input.branchId,
      branchSessionId: input.fallback.branchSessionId,
      status,
      startedAt: input.fallback.startedAt,
      completedAt,
    }
    const spawn: BranchSpawnMeta = {
      branchId: input.branchId,
      branchSessionId: input.fallback.branchSessionId,
    }
    const userMsg: Message = {
      ...createUserMessage(input.fallback.userQuery, lastUuid(messages)),
      branchSpawn: spawn,
    }
    const assistantMsg: Message = {
      ...createAssistantMessage({
        content: [{
          type: 'text',
          text: input.outcome.kind === 'success'
            ? input.outcome.finalText
            : branchPlaceholderText(meta, input.outcome.reason),
        }],
        stopReason: 'branch_placeholder',
        usage: {},
        parentUuid: userMsg.uuid,
      }),
      branchPlaceholder: meta,
    }
    await appendMessage(input.mainSessionId, userMsg)
    await appendMessage(input.mainSessionId, assistantMsg)
    process.stderr.write(
      `branch ${input.branchId} merge-back fell back to append (placeholder missing in ${input.mainSessionId}, likely compacted)\n`,
    )
    return { kind: 'fallback-appended' }
  })
}

export async function recoverOrphanedBranchPlaceholders(
  sessionsDir: string,
): Promise<number> {
  let entries: Dirent[]
  try {
    entries = await readdir(sessionsDir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 0
    }
    throw error
  }

  let recovered = 0
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('feishu-')) {
      continue
    }
    const messages = await loadTranscript(entry.name)
    let changed = false
    const next = messages.map(message => {
      if (
        message.type !== 'assistant' ||
        message.branchPlaceholder?.status !== 'running'
      ) {
        return message
      }
      if (existsSync(getSessionDir(message.branchPlaceholder.branchSessionId))) {
        return message
      }
      changed = true
      recovered += 1
      const meta: BranchPlaceholderMeta = {
        ...message.branchPlaceholder,
        status: 'interrupted',
        completedAt: new Date().toISOString(),
      }
      return {
        ...message,
        branchPlaceholder: meta,
        message: {
          ...message.message,
          content: [{ type: 'text', text: branchPlaceholderText(meta) }],
        },
      } satisfies Message
    })
    if (changed) {
      await rewriteTranscript(entry.name, next)
    }
  }
  return recovered
}

function branchPlaceholderText(meta: BranchPlaceholderMeta, reason?: string): string {
  if (meta.status === 'running') {
    return t('branch.placeholder.running', { id: meta.branchId })
  }
  if (meta.status === 'failed') {
    return t('branch.placeholder.failed', {
      id: meta.branchId,
      reason: reason ?? t('bg.card.failure.unknownReason'),
    })
  }
  if (meta.status === 'interrupted') {
    return t('branch.placeholder.interrupted', { id: meta.branchId })
  }
  return t('branch.placeholder.completed', { id: meta.branchId })
}

function lastUuid(messages: Message[]): string | null {
  return messages.length > 0 ? messages[messages.length - 1]?.uuid ?? null : null
}
