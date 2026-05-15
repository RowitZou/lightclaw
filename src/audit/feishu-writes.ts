import { appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

import {
  classifyFeishuError,
  FeishuApiError,
  type FeishuErrorKind,
} from '../channels/feishu/resources/errors.js'
import { lightclawHome } from '../paths.js'
import { getCurrentUserId } from '../state.js'

export type FeishuPermissionGrants = {
  // Group chat-level view grant. 'view' = success (or already-exists);
  // 'failed' = API call rejected; 'skipped-not-group' = DM session (chat
  // grant would be redundant because the user grant covers the sole
  // counterparty).
  chat?: 'view' | 'failed' | 'skipped-not-group'
  // Sender-level full_access grant. 'full_access' = success (or
  // already-exists); 'failed' = API call rejected; 'skipped-no-binding' =
  // could not resolve a Feishu open_id for the requester (terminal admin
  // with no Feishu pairing, etc.).
  user?: 'full_access' | 'failed' | 'skipped-no-binding'
  errors?: string[]
}

export type FeishuWriteOperation =
  | 'create-doc'
  | 'create-sheet'
  | 'upload-file'
  | 'append-doc'
  | 'append-doc-markdown'
  | 'insert-doc-markdown'
  | 'replace-doc'
  | 'update-doc-block'
  | 'delete-doc-block'
  | 'create-doc-table'
  | 'write-doc-table-cells'
  | 'create-doc-table-with-values'
  | 'insert-doc-table-row'
  | 'insert-doc-table-column'
  | 'delete-doc-table-rows'
  | 'delete-doc-table-columns'
  | 'merge-doc-table-cells'
  | 'upload-doc-image'
  | 'upload-doc-file'
  | 'append-sheet-rows'
  | 'overwrite-sheet-range'
  | 'clear-sheet-range'
  | 'add-sheet'
  | 'delete-sheet'
  | 'create-folder'
  | 'move'
  | 'delete'
  | 'boundary-violation'
  | 'admin-delete-workspace'

export type FeishuWriteAudit = {
  at: string
  userId: string | undefined
  operation: FeishuWriteOperation
  resource?: Record<string, unknown>
  preview?: string
  status?: 'confirmed' | 'denied' | 'failed'
  error?: string | FeishuWriteAuditError
  retries?: number
  permissionGrants?: FeishuPermissionGrants
  ancestryChain?: string[]
  sourceAncestry?: string[]
  destAncestry?: string[]
  boundaryViolation?: Record<string, unknown>
}

export type FeishuWriteAuditError = {
  kind: FeishuErrorKind
  message: string
  code?: number
  logId?: string
}

export async function recordFeishuWriteAudit(record: FeishuWriteAudit): Promise<void> {
  const dir = path.join(lightclawHome(), 'audit', 'feishu-writes')
  await mkdir(dir, { recursive: true })
  const day = record.at.slice(0, 10)
  await appendFile(path.join(dir, `${day}.jsonl`), `${JSON.stringify(record)}\n`, 'utf8')
}

export async function auditFailed(
  operation: FeishuWriteOperation,
  preview: string,
  resource: Record<string, unknown>,
  error: unknown,
  extras: {
    ancestryChain?: string[]
    sourceAncestry?: string[]
    destAncestry?: string[]
    retries?: number
  } = {},
): Promise<void> {
  await recordFeishuWriteAudit({
    at: new Date().toISOString(),
    userId: safeCurrentUserId(),
    operation,
    resource,
    preview,
    status: 'failed',
    error: feishuAuditError(error),
    ...(extras.retries && extras.retries > 0 ? { retries: extras.retries } : {}),
    ...(extras.ancestryChain ? { ancestryChain: extras.ancestryChain } : {}),
    ...(extras.sourceAncestry ? { sourceAncestry: extras.sourceAncestry } : {}),
    ...(extras.destAncestry ? { destAncestry: extras.destAncestry } : {}),
  })
}

function feishuAuditError(error: unknown): FeishuWriteAuditError {
  const c = error instanceof FeishuApiError ? error.classification : classifyFeishuError(error)
  return {
    kind: c.kind,
    message: c.agentMessage,
    ...(c.code !== undefined ? { code: c.code } : {}),
    ...(c.logId ? { logId: c.logId } : {}),
  }
}

function safeCurrentUserId(): string | undefined {
  try {
    return getCurrentUserId()
  } catch {
    return undefined
  }
}
