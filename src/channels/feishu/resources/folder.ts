import type { FeishuClient } from '../client.js'
import { callFeishu, feishuErrorMessage, type FeishuEnvelope } from './api.js'

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
  const result = await callFeishu(() => client.drive.v1.file.createFolder({
    data: {
      folder_token: input.parentFolderToken,
      name: input.name,
    },
  }))
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
  return { items, truncated, rawData }
}

export async function getFileMetadata(input: {
  client: FeishuClient
  token: string
  /**
   * When the SDK only exposes `metadata.batchQuery` (no direct `getMetadata`),
   * Feishu requires `request_docs[].doc_type` alongside `doc_token`. Callers
   * that know the type (e.g. ancestry walk after the first hop) should pass
   * it. When unknown, this helper tries common types sequentially — slower
   * but lets ancestry seed without a prior list call. The direct `getMetadata`
   * branch ignores this hint since it auto-detects.
   */
  docTypeHint?: 'folder' | 'docx' | 'doc' | 'sheet' | 'bitable' | 'file'
}): Promise<FeishuFolderItem | null> {
  const client = input.client as unknown as FeishuFolderClient
  const getter = client.drive.v1.file.getMetadata
  if (getter) {
    const result = await callFeishu(() => getter({
      params: { file_token: input.token },
    }))
    return normalizeMetadataResult(input.token, result.data)
  }
  const batchQuery = client.drive.v1.metadata?.batchQuery
  if (!batchQuery) {
    throw new Error('Feishu metadata API is unavailable in this SDK client.')
  }
  const docTypes = input.docTypeHint
    ? [input.docTypeHint]
    : (['folder', 'docx', 'sheet', 'bitable', 'file'] as const)
  for (const docType of docTypes) {
    try {
      const result = await callFeishu(() => batchQuery({
        data: {
          request_docs: [{ doc_token: input.token, doc_type: docType }],
          with_url: false,
        },
      }))
      const item = normalizeMetadataResult(input.token, result.data)
      if (item) {
        return item
      }
    } catch (error) {
      // Wrong doc_type for a real token typically returns Feishu 99992402
      // "field validation failed" or 1064xxx not-found. Swallow and try the
      // next type; if all fail the loop ends and we return null upstream.
      void error
    }
  }
  return null
}

export async function deleteFile(input: {
  client: FeishuClient
  token: string
  type: FeishuDriveItemType
}): Promise<FeishuEnvelope> {
  const client = input.client as unknown as FeishuFolderClient
  return callFeishu(() => client.drive.v1.file.delete({
    path: { file_token: input.token },
    params: { type: driveType(input.type) },
  }))
}

export async function moveFile(input: {
  client: FeishuClient
  token: string
  type: FeishuDriveItemType
  destFolderToken: string
}): Promise<FeishuEnvelope> {
  const client = input.client as unknown as FeishuFolderClient
  return callFeishu(() => client.drive.v1.file.move({
    path: { file_token: input.token },
    params: { type: driveType(input.type) },
    data: { folder_token: input.destFolderToken },
  }))
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
    const message = feishuErrorMessage(error)
    const alreadyExists = /already\s*(?:exist|been|added)|has\s*(?:already\s*)?been\s*added|duplicate|repeat/i.test(message) ||
      /1061\d{3}/.test(message)
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

function normalizeMetadataResult(token: string, data: unknown): FeishuFolderItem | null {
  const raw = readArray(data, ['metas'])[0] ??
    readArray(data, ['docs'])[0] ??
    readArray(data, ['files'])[0] ??
    (typeof data === 'object' && data !== null ? data : undefined)
  if (!raw) {
    return null
  }
  return normalizeFolderItem(raw, token)
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
      metadata?: {
        batchQuery(input: unknown): Promise<FeishuEnvelope>
      }
      file: {
        createFolder(input: unknown): Promise<FeishuEnvelope>
        list(input: unknown): Promise<FeishuEnvelope>
        delete(input: unknown): Promise<FeishuEnvelope>
        move(input: unknown): Promise<FeishuEnvelope>
        getMetadata?: (input: unknown) => Promise<FeishuEnvelope>
      }
    }
  }
}
