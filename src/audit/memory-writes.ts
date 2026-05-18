import { appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

import { lightclawHome } from '../paths.js'
import { getCurrentUserId } from '../state.js'

export type MemoryWriteAudit = {
  at: string
  userId: string | undefined
  role: string
  filename: string
  targetPath: string
  status: 'written' | 'denied'
  deniedReason?: string
  operation?: 'write' | 'read'
  /** L1 = user root, L2 = `_shared`, L3 = role-private. Set when the
   *  target falls within the memory dir; omitted on boundary violations
   *  (path resolves outside memoryDir). Resolved via
   *  `resolveSourceTier` in `src/memory/scope.ts`. */
  sourceTier?: 'L1' | 'L2' | 'L3'
}

export async function recordMemoryWriteAudit(record: MemoryWriteAudit): Promise<void> {
  const dir = path.join(lightclawHome(), 'audit', 'memory-writes')
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
