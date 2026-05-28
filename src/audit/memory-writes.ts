import { appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

import { resolveAuditDir } from '../config.js'
import { getCurrentUserId } from '../state.js'

export type MemoryWriteAudit = {
  at: string
  userId: string | undefined
  role: string
  filename: string
  targetPath: string
  /** Outcome. `written` covers MemoryWrite / MemoryWriteAt success; `moved` /
   *  `deleted` are the memoryCurator-only verbs; `denied` is a guard /
   *  validation refusal; `failed` is an unexpected fs / runtime error after
   *  the op was attempted. Pre-2026-05-28 only `written` / `denied` existed
   *  (MemoryWrite + read); memoryCurator's MemoryWriteAt / MemoryMove /
   *  MemoryDelete wrote nothing here, so its destructive ops (the 5/26 §1
   *  误删 class) were invisible to post-hoc audit. This widening closes that. */
  status: 'written' | 'moved' | 'deleted' | 'denied' | 'failed'
  deniedReason?: string
  operation?: 'write' | 'read' | 'write-at' | 'move' | 'delete'
  /** Source relative path for `operation: 'move'` (targetPath carries the
   *  destination). Omitted for every other operation. */
  movedFrom?: string
  /** L1 = user root, L2 = `_shared`, L3 = role-private. Set when the
   *  target falls within the memory dir; omitted on boundary violations
   *  (path resolves outside memoryDir). Resolved via
   *  `resolveSourceTier` in `src/memory/scope.ts`. */
  sourceTier?: 'L1' | 'L2' | 'L3'
}

export async function recordMemoryWriteAudit(record: MemoryWriteAudit): Promise<void> {
  const dir = path.join(resolveAuditDir(), 'memory-writes')
  await mkdir(dir, { recursive: true })
  const day = record.at.slice(0, 10)
  await appendFile(path.join(dir, `${day}.jsonl`), `${JSON.stringify(record)}\n`, 'utf8')
}

export function safeMemoryAuditUserId(): string | undefined {
  try {
    return getCurrentUserId()
  } catch {
    return undefined
  }
}
