import type { FeishuClient } from '../client.js'
import { getWorkspaceParentCache } from '../workspace/ancestry.js'
import { callFeishu, type FeishuEnvelope } from './api.js'
import { classifyFeishuError, logFeishuRetry } from './errors.js'
import { withFeishuRetry } from './retry.js'

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
}): Promise<{ folderToken: string; name: string; rawData?: unknown }> {
  const client = input.client as unknown as FeishuFolderClient
  const result = await withFeishuRetry(() => callFeishu(() => client.drive.v1.file.createFolder({
    data: {
      folder_token: input.parentFolderToken,
      name: input.name,
    },
  })), { onRetry: (c, attempt, delayMs) => logFeishuRetry(c, attempt, delayMs, 'folder.create') })
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
}): Promise<FeishuEnvelope> {
  const client = input.client as unknown as FeishuFolderClient
  return withFeishuRetry(() => callFeishu(() => client.drive.v1.file.delete({
    path: { file_token: input.token },
    params: { type: driveType(input.type) },
  })), { onRetry: (c, attempt, delayMs) => logFeishuRetry(c, attempt, delayMs, 'folder.delete') })
}

export async function moveFile(input: {
  client: FeishuClient
  token: string
  type: FeishuDriveItemType
  destFolderToken: string
}): Promise<FeishuEnvelope> {
  const client = input.client as unknown as FeishuFolderClient
  return withFeishuRetry(() => callFeishu(() => client.drive.v1.file.move({
    path: { file_token: input.token },
    params: { type: driveType(input.type) },
    data: { folder_token: input.destFolderToken },
  })), { onRetry: (c, attempt, delayMs) => logFeishuRetry(c, attempt, delayMs, 'folder.move') })
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
