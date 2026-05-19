import { mkdir, appendFile } from 'node:fs/promises'
import path from 'node:path'

import { resolveAuditDir } from '../config.js'
import type { ChainGuardReason } from '../signal-bus/chain-guard.js'
import type { ChainState } from '../signal-bus/chain-state.js'

export type DispatchAuditRecord = {
  at: string
  chainId: string
  parentDispatchId?: string | null
  dispatchId?: string
  from?: { role: string; sessionId?: string }
  to?: { role: string; internalRole?: string; sessionId?: string }
  depth?: number
  status?: 'start' | 'complete' | 'failed' | 'rejected-by-guard' | 'aborted'
  chainStatePath?: ChainState['path']
  chainStartedAt?: number
  caller: { role: string; sessionId?: string }
  callee: { role: string; internalRole?: string; sessionId?: string }
  schedule: unknown
  mode: 'blocking' | 'background'
  outcome: 'success' | 'failed' | 'aborted' | 'rejected-by-guard'
  durationMs: number
  finalTextPreview?: string
  chainState?: ChainState
  guardReason?: ChainGuardReason
  resumeFromDispatchId?: string
}

export async function appendDispatchAudit(record: DispatchAuditRecord): Promise<void> {
  const day = record.at.slice(0, 10)
  const dir = path.join(resolveAuditDir(), 'dispatch', day)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, `${sanitize(record.chainId)}.jsonl`)
  await appendFile(file, `${JSON.stringify(enrichDispatchAuditRecord(record))}\n`, { mode: 0o600 })
}

function enrichDispatchAuditRecord(record: DispatchAuditRecord): DispatchAuditRecord {
  const leaf = record.chainState?.path.at(-1)
  return {
    ...record,
    dispatchId: record.dispatchId ?? leaf?.dispatchId,
    from: record.from ?? record.caller,
    to: record.to ?? record.callee,
    depth: record.depth ?? record.chainState?.depth,
    status: record.status ?? statusFromOutcome(record.outcome),
    chainStatePath: record.chainStatePath ?? record.chainState?.path,
    chainStartedAt: record.chainStartedAt ?? record.chainState?.chainStartedAt,
  }
}

function statusFromOutcome(
  outcome: DispatchAuditRecord['outcome'],
): NonNullable<DispatchAuditRecord['status']> {
  if (outcome === 'success') return 'complete'
  return outcome
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 160) || 'root'
}
