import { existsSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'

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

export async function mergeBranchResultBack(input: {
  mainSessionId: string
  branchId: string
  outcome: BranchOutcome
}): Promise<void> {
  await channelSessionLock.runExclusive(input.mainSessionId, async () => {
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
    }
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
    return `[branch #${meta.branchId} running...]`
  }
  if (meta.status === 'failed') {
    return `[branch #${meta.branchId} failed: ${reason ?? 'unknown error'}]`
  }
  if (meta.status === 'interrupted') {
    return `[branch #${meta.branchId} interrupted before completion]`
  }
  return `[branch #${meta.branchId} completed]`
}

function lastUuid(messages: Message[]): string | null {
  return messages.length > 0 ? messages[messages.length - 1]?.uuid ?? null : null
}
