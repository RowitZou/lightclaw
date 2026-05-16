import { mkdir, appendFile } from 'node:fs/promises'
import path from 'node:path'

import { lightclawHome } from '../paths.js'

export type DispatchAuditRecord = {
  at: string
  chainId: string
  parentDispatchId?: string | null
  caller: { role: string; sessionId?: string }
  callee: { role: string; internalRole?: string; sessionId?: string }
  schedule: unknown
  mode: 'blocking' | 'background'
  outcome: 'success' | 'failed' | 'aborted'
  durationMs: number
  finalTextPreview?: string
}

export async function appendDispatchAudit(record: DispatchAuditRecord): Promise<void> {
  const day = record.at.slice(0, 10)
  const dir = path.join(lightclawHome(), 'audit', 'dispatch', day)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, `${sanitize(record.chainId)}.jsonl`)
  await appendFile(file, `${JSON.stringify(record)}\n`, { mode: 0o600 })
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 160) || 'root'
}

