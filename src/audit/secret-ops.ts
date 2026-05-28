import { appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

import { resolveAuditDir } from '../config.js'

export type SecretOp =
  | 'set'
  | 'set-replace'
  | 'enable'
  | 'disable'
  | 'remove'
  | 'import-env'
  | 'import-file'

export type SecretOpAuditEntry = {
  ts: string
  user: string
  op: SecretOp
  name: string
  source: 'chat' | 'env' | 'file'
}

export async function appendSecretOpAudit(entry: SecretOpAuditEntry): Promise<void> {
  const dir = path.join(resolveAuditDir(), 'secret-ops')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, `${entry.ts.slice(0, 10)}.jsonl`)
  await appendFile(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
}
