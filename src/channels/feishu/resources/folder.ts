import type { FeishuClient } from '../client.js'
import { getWorkspaceParentCache } from '../workspace/ancestry.js'
import { callFeishu, type FeishuEnvelope } from './api.js'
import { updateDocBlockText } from './doc.js'
import { classifyFeishuError, logFeishuRetry } from './errors.js'
import { withFeishuRetry } from './retry.js'
import { renameSpreadsheet } from './sheet.js'

export type FeishuDriveItemType = 'folder' | 'docx' | 'doc' | 'sheet' | 'bitable' | 'file' | 'unknown'

export type FeishuFolderItem = {
  token: string
  name: string
  type: FeishuDriveItemType
  parentToken?: string
  modifiedTime?: string
  rawData?: unknown
}

export type FeishuFolderListResult = {
  items: FeishuFolderItem[]
  truncated: boolean
  rawData?: unknown
}

export async function createFolder(input: {
  client: FeishuClient
  parentFolderToken: string
  name: string
  retryCounter?: { count: number }
}): Promise<{ folderToken: string; name: string; rawData?: unknown }> {
  const client = input.client as unknown as FeishuFolderClient
  const result = await withFeishuRetry(() => callFeishu(() => client.drive.v1.file.createFolder({
    data: {
      folder_token: input.parentFolderToken,
      name: input.name,
    },
  })), {
    onRetry: (c, attempt, delayMs) => logFeishuRetry(c, attempt, delayMs, 'folder.create'),
    ...(input.retryCounter ? { retryCounter: input.retryCounter } : {}),
  })
  const folderToken = readNestedString(result.data, ['folder', 'token']) ??
    readNestedString(result.data, ['folder_token']) ??
    readNestedString(result.data, ['token'])
  if (!folderToken) {
    throw new Error('Feishu createFolder response did not include a folder token.')
  }
  const name = readNestedString(result.data, ['folder', 'name']) ??
    readNestedString(result.data, ['name']) ??
    input.name
  return { folderToken, name, rawData: result.data }
}

export async function listFolder(input: {
  client: FeishuClient
  folderToken: string
  pageSize?: number
  maxItems?: number
}): Promise<FeishuFolderListResult> {
  const client = input.client as unknown as FeishuFolderClient
  const pageSize = input.pageSize ?? 200
  const maxItems = input.maxItems ?? 1000
  const items: FeishuFolderItem[] = []
  let pageToken: string | undefined
  let rawData: unknown
  let truncated = false
  do {
    const result = await callFeishu(() => client.drive.v1.file.list({
      params: {
        folder_token: input.folderToken,
        page_size: pageSize,
        ...(pageToken ? { page_token: pageToken } : {}),
      },
    }))
    rawData = result.data
    for (const raw of readArray(result.data, ['files'])) {
      if (items.length >= maxItems) {
        truncated = true
        break
      }
      const item = normalizeFolderItem(raw)
      if (item) {
        items.push(item)
      }
    }
    if (truncated) {
      break
    }
    pageToken = readNestedString(result.data, ['page_token']) ??
      readNestedString(result.data, ['next_page_token'])
  } while (pageToken)
  // Populate workspace parent cache with every (child, parent=folderToken)
  // edge observed here. This is the *only* way ancestry containment checks
  // know whether a token T is inside user workspace U — Feishu's metadata
  // API does not expose parent_token at all (`drive.v1.meta.batchQuery`
  // returns title/owner/timestamps but no parent), so we infer the inverse
  // direction (parent → children) from list responses opportunistically.
  // See ancestry.ts for the full rationale.
  const cache = getWorkspaceParentCache()
  for (const item of items) {
    cache.observeChild(item.token, input.folderToken)
  }
  return { items, truncated, rawData }
}

export async function deleteFile(input: {
  client: FeishuClient
  token: string
  type: FeishuDriveItemType
  retryCounter?: { count: number }
}): Promise<FeishuEnvelope> {
  const client = input.client as unknown as FeishuFolderClient
  return withFeishuRetry(() => callFeishu(() => client.drive.v1.file.delete({
    path: { file_token: input.token },
    params: { type: driveType(input.type) },
  })), {
    onRetry: (c, attempt, delayMs) => logFeishuRetry(c, attempt, delayMs, 'folder.delete'),
    ...(input.retryCounter ? { retryCounter: input.retryCounter } : {}),
  })
}

export async function moveFile(input: {
  client: FeishuClient
  token: string
  type: FeishuDriveItemType
  destFolderToken: string
  retryCounter?: { count: number }
}): Promise<FeishuEnvelope> {
  const client = input.client as unknown as FeishuFolderClient
  // POST /drive/v1/files/{token}/move takes BOTH `type` and `folder_token`
  // in the request body. Sending `type` as a query param (the shape the
  // DELETE endpoint uses) returns 400 code=1061002 "params error." on every
  // call — FeishuMove had never succeeded in production until this landed.
  return withFeishuRetry(() => callFeishu(() => client.drive.v1.file.move({
    path: { file_token: input.token },
    data: { type: driveType(input.type), folder_token: input.destFolderToken },
  })), {
    onRetry: (c, attempt, delayMs) => logFeishuRetry(c, attempt, delayMs, 'folder.move'),
    ...(input.retryCounter ? { retryCounter: input.retryCounter } : {}),
  })
}

// Feishu has NO drive-level rename API (no PATCH /drive/v1/files/{token};
// the SDK's only bare files/{token} route is DELETE). Renames are per-type:
//   - docx: the document title IS the page block's text (block_id ==
//     document_id), so a documentBlock.patch on that block renames the doc.
//   - sheet: PATCH /sheets/v3/spreadsheets/{token} with { title }.
//   - folder: no API at all — recreate under a new name, move the children
//     over, then trash the drained old folder. The folder's own token
//     changes (returned as `newToken`); contained items keep their tokens.
export async function renameFile(input: {
  client: FeishuClient
  token: string
  type: FeishuDriveItemType
  name: string
  /** Current parent folder — required for the folder recreate path. */
  parentFolderToken?: string
  retryCounter?: { count: number }
  /** Folder recreate: how long to wait between drain checks (test override). */
  pollIntervalMs?: number
  /** Folder recreate: how many drain checks before giving up (old folder is kept). */
  maxPollAttempts?: number
}): Promise<{ newToken?: string }> {
  if (input.type === 'doc' || input.type === 'docx') {
    await updateDocBlockText({
      client: input.client,
      documentId: input.token,
      blockId: input.token,
      content: input.name,
      ...(input.retryCounter ? { retryCounter: input.retryCounter } : {}),
    })
    return {}
  }
  if (input.type === 'sheet') {
    await renameSpreadsheet({
      client: input.client,
      spreadsheetToken: input.token,
      title: input.name,
      ...(input.retryCounter ? { retryCounter: input.retryCounter } : {}),
    })
    return {}
  }
  if (input.type === 'folder') {
    if (!input.parentFolderToken) {
      throw new Error('Renaming a folder requires its parent folder token.')
    }
    return renameFolderViaRecreate({
      client: input.client,
      token: input.token,
      parentFolderToken: input.parentFolderToken,
      name: input.name,
      ...(input.retryCounter ? { retryCounter: input.retryCounter } : {}),
      ...(input.pollIntervalMs !== undefined ? { pollIntervalMs: input.pollIntervalMs } : {}),
      ...(input.maxPollAttempts !== undefined ? { maxPollAttempts: input.maxPollAttempts } : {}),
    })
  }
  throw new Error(`Feishu has no rename API for drive item type "${input.type}". Only docs, sheets, and folders can be renamed.`)
}

async function renameFolderViaRecreate(input: {
  client: FeishuClient
  token: string
  parentFolderToken: string
  name: string
  retryCounter?: { count: number }
  pollIntervalMs?: number
  maxPollAttempts?: number
}): Promise<{ newToken: string }> {
  const retry = input.retryCounter ? { retryCounter: input.retryCounter } : {}
  // Enumerate BEFORE any mutation so an over-large folder is refused cleanly.
  const children = await listFolder({ client: input.client, folderToken: input.token })
  if (children.truncated) {
    throw new Error(`Folder rename recreates the folder and moves its contents, but this folder has more items than one rename pass handles (${children.items.length}+). Move the contents in batches instead.`)
  }
  const created = await createFolder({
    client: input.client,
    parentFolderToken: input.parentFolderToken,
    name: input.name,
    ...retry,
  })
  const newToken = created.folderToken
  for (const child of children.items) {
    await moveFile({
      client: input.client,
      token: child.token,
      type: child.type,
      destFolderToken: newToken,
      ...retry,
    })
  }
  // Folder-type child moves run async server-side (the move API returns a
  // task_id for folders), so wait until the old folder actually reads empty.
  // Never trash a folder that still lists content — that would delete data.
  const maxAttempts = input.maxPollAttempts ?? 10
  const intervalMs = input.pollIntervalMs ?? 1000
  for (let attempt = 0; ; attempt++) {
    const remaining = await listFolder({ client: input.client, folderToken: input.token, maxItems: 1 })
    if (remaining.items.length === 0) {
      break
    }
    if (attempt >= maxAttempts - 1) {
      throw new Error(`Folder rename created "${input.name}" (token=${newToken}) and moved ${children.items.length} item(s) into it, but the old folder still lists content after ${maxAttempts} checks — the old folder was NOT deleted. Verify both folders with FeishuList before retrying.`)
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
  await deleteFile({ client: input.client, token: input.token, type: 'folder', ...retry })
  const cache = getWorkspaceParentCache()
  cache.observeChild(newToken, input.parentFolderToken)
  for (const child of children.items) {
    cache.observeChild(child.token, newToken)
  }
  cache.evict(input.token)
  return { newToken }
}

export async function grantFolderPermission(input: {
  client: FeishuClient
  folderToken: string
  openId: string
  perm: 'view' | 'edit' | 'full_access'
}): Promise<{ ok: true } | { ok: false; error: string; alreadyExists: boolean }> {
  const client = input.client as unknown as FeishuFolderClient
  try {
    await callFeishu(() => client.drive.permissionMember.create({
      path: { token: input.folderToken },
      params: { type: 'folder', need_notification: false },
      data: { member_type: 'openid', member_id: input.openId, perm: input.perm },
    }))
    return { ok: true }
  } catch (error) {
    const c = classifyFeishuError(error)
    const message = c.agentMessage
    const alreadyExists = c.kind === 'already-exists'
    if (!alreadyExists) {
      process.stderr.write(
        `feishu-workspace user-folder grant failed: openid/${input.openId} on folder ${input.folderToken} (perm=${input.perm}): ${message}\n`,
      )
    }
    return { ok: false, error: message, alreadyExists }
  }
}

// Grant access to a drive file (PDFs / images / archives uploaded via
// `drive.v1.file.upload_*`). Same SDK call as grantFolderPermission, but
// `params.type='file'` addresses an attachment rather than a folder. Used by
// SendFile cloud fallback to give the IM sender (and, in groups, the
// chat-as-collaborator) view access so the share link the bot posts back is
// clickable for them without going through Feishu's `Request access` flow.
export async function grantFilePermission(input: {
  client: FeishuClient
  fileToken: string
  memberType: 'openid' | 'openchat'
  memberId: string
  perm: 'view' | 'edit' | 'full_access'
}): Promise<{ ok: true } | { ok: false; error: string; alreadyExists: boolean }> {
  const client = input.client as unknown as FeishuFolderClient
  try {
    await callFeishu(() => client.drive.permissionMember.create({
      path: { token: input.fileToken },
      params: { type: 'file', need_notification: false },
      data: { member_type: input.memberType, member_id: input.memberId, perm: input.perm },
    }))
    return { ok: true }
  } catch (error) {
    const c = classifyFeishuError(error)
    const message = c.agentMessage
    const alreadyExists = c.kind === 'already-exists'
    if (!alreadyExists) {
      process.stderr.write(
        `feishu-uploads file grant failed: ${input.memberType}/${input.memberId} on file ${input.fileToken} (perm=${input.perm}): ${message}\n`,
      )
    }
    return { ok: false, error: message, alreadyExists }
  }
}

export function driveType(type: FeishuDriveItemType): 'folder' | 'docx' | 'sheet' | 'bitable' | 'file' {
  if (type === 'folder') return 'folder'
  if (type === 'sheet') return 'sheet'
  if (type === 'bitable') return 'bitable'
  if (type === 'file') return 'file'
  return 'docx'
}

function normalizeFolderItem(raw: unknown, fallbackToken?: string): FeishuFolderItem | null {
  const token = readNestedString(raw, ['token']) ??
    readNestedString(raw, ['file_token']) ??
    readNestedString(raw, ['doc_token']) ??
    readNestedString(raw, ['document_id']) ??
    fallbackToken
  if (!token) {
    return null
  }
  const type = normalizeDriveType(
    readNestedString(raw, ['type']) ??
    readNestedString(raw, ['doc_type']) ??
    readNestedString(raw, ['file_type']),
  )
  return {
    token,
    name:
      readNestedString(raw, ['name']) ??
      readNestedString(raw, ['title']) ??
      readNestedString(raw, ['file_name']) ??
      token,
    type,
    ...(readNestedString(raw, ['parent_token']) ? { parentToken: readNestedString(raw, ['parent_token'])! } : {}),
    ...(readNestedString(raw, ['modified_time']) ? { modifiedTime: readNestedString(raw, ['modified_time'])! } : {}),
    rawData: raw,
  }
}

function normalizeDriveType(value: string | undefined): FeishuDriveItemType {
  if (value === 'folder') return 'folder'
  if (value === 'doc' || value === 'docx') return value
  if (value === 'sheet' || value === 'spreadsheet') return 'sheet'
  if (value === 'bitable' || value === 'file') return value
  return 'unknown'
}

function readNestedString(input: unknown, path: string[]): string | undefined {
  let cur = input
  for (const key of path) {
    if (!cur || typeof cur !== 'object' || !(key in cur)) {
      return undefined
    }
    cur = (cur as Record<string, unknown>)[key]
  }
  return typeof cur === 'string' && cur.length > 0 ? cur : undefined
}

function readArray(input: unknown, path: string[]): unknown[] {
  let cur = input
  for (const key of path) {
    if (!cur || typeof cur !== 'object' || !(key in cur)) {
      return []
    }
    cur = (cur as Record<string, unknown>)[key]
  }
  return Array.isArray(cur) ? cur : []
}

type FeishuFolderClient = {
  request?(input: unknown): Promise<FeishuEnvelope>
  drive: {
    permissionMember: {
      create(input: unknown): Promise<FeishuEnvelope>
    }
    v1: {
      file: {
        createFolder(input: unknown): Promise<FeishuEnvelope>
        list(input: unknown): Promise<FeishuEnvelope>
        delete(input: unknown): Promise<FeishuEnvelope>
        move(input: unknown): Promise<FeishuEnvelope>
      }
    }
  }
}
