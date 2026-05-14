import type { FeishuClient } from '../client.js'
import { callFeishu, type FeishuEnvelope } from './api.js'
import { readNestedString, truncate } from './common.js'
import { classifyFeishuError, logFeishuRetry } from './errors.js'
import { withFeishuRetry } from './retry.js'

export type FeishuDocCreateResult = {
  documentId?: string
  title: string
  url?: string
  rawData?: unknown
}

export type FeishuDocReadResult = {
  documentId: string
  title?: string
  content: string
  truncated: boolean
  revision_id?: string
  block_count: number
  block_types: Record<string, number>
  blocks?: Array<Record<string, unknown>>
  hint?: string
  rawData?: unknown
}

const STRUCTURED_BLOCK_TYPES = new Set([14, 18, 21, 23, 27, 30, 31, 32])

const BLOCK_TYPE_NAMES: Record<number, string> = {
  1: 'Page',
  2: 'Text',
  3: 'Heading1',
  4: 'Heading2',
  5: 'Heading3',
  12: 'Bullet',
  13: 'Ordered',
  14: 'Code',
  15: 'Quote',
  17: 'Todo',
  18: 'Bitable',
  21: 'Diagram',
  22: 'Divider',
  23: 'File',
  27: 'Image',
  30: 'Sheet',
  31: 'Table',
  32: 'TableCell',
}

export async function readDocPlainText(input: {
  client: FeishuClient
  documentId: string
  maxChars: number
  includeBlocks?: boolean
}): Promise<FeishuDocReadResult> {
  const client = input.client as FeishuDocClient
  const [info, raw, blocks] = await Promise.all([
    callFeishu(() => client.docx.document.get({ path: { document_id: input.documentId } })),
    callFeishu(() => client.docx.document.rawContent({ path: { document_id: input.documentId } })),
    callFeishu(() => client.docx.documentBlock.list({ path: { document_id: input.documentId } })),
  ])
  const title = readNestedString(info.data, ['document', 'title']) ??
    readNestedString(info.data, ['title'])
  const revisionId = readNestedString(info.data, ['document', 'revision_id']) ??
    readNestedString(info.data, ['revision_id'])
  const content = readNestedString(raw.data, ['content']) ??
    readNestedString(raw.data, ['document', 'content']) ??
    ''
  const clipped = truncate(content, input.maxChars)
  const blockItems = readBlockItems(blocks.data)
  const blockTypes: Record<string, number> = {}
  const structuredTypes: string[] = []
  for (const block of blockItems) {
    const blockType = typeof block.block_type === 'number' ? block.block_type : 0
    const name = BLOCK_TYPE_NAMES[blockType] ?? `type_${blockType}`
    blockTypes[name] = (blockTypes[name] ?? 0) + 1
    if (STRUCTURED_BLOCK_TYPES.has(blockType) && !structuredTypes.includes(name)) {
      structuredTypes.push(name)
    }
  }
  const hint = structuredTypes.length > 0
    ? input.includeBlocks
      ? `This document contains ${structuredTypes.join(', ')} which are NOT included in the plain text above. Structured block details are included in the blocks field.`
      : `This document contains ${structuredTypes.join(', ')} which are NOT included in the plain text above. Re-run FeishuRead with include_blocks:true to return the raw document blocks.`
    : undefined

  return {
    documentId: input.documentId,
    ...(title ? { title } : {}),
    content: clipped.value,
    truncated: clipped.truncated,
    ...(revisionId ? { revision_id: revisionId } : {}),
    block_count: blockItems.length,
    block_types: blockTypes,
    ...(input.includeBlocks ? { blocks: blockItems } : {}),
    ...(hint ? { hint } : {}),
    ...(content ? {} : { rawData: raw.data }),
  }
}

function readBlockItems(input: unknown): Array<Record<string, unknown>> {
  if (!input || typeof input !== 'object') {
    return []
  }
  const items = (input as Record<string, unknown>).items
  if (!Array.isArray(items)) {
    return []
  }
  return items.filter((item): item is Record<string, unknown> =>
    Boolean(item) && typeof item === 'object')
}

export async function createDoc(input: {
  client: FeishuClient
  title: string
  content?: string
  folderToken?: string
  retryCounter?: { count: number }
}): Promise<FeishuDocCreateResult> {
  const client = input.client as FeishuDocClient
  const created = await withFeishuRetry(() => callFeishu(() => client.docx.document.create({
    data: {
      title: input.title,
      ...(input.folderToken ? { folder_token: input.folderToken } : {}),
    },
  })), {
    onRetry: (c, attempt, delayMs) => logFeishuRetry(c, attempt, delayMs, 'docx.create'),
    ...(input.retryCounter ? { retryCounter: input.retryCounter } : {}),
  })
  const documentId = readNestedString(created.data, ['document', 'document_id']) ??
    readNestedString(created.data, ['document_id'])
  if (documentId && input.content?.trim()) {
    await appendDocText({
      client: input.client,
      documentId,
      content: input.content,
      ...(input.retryCounter ? { retryCounter: input.retryCounter } : {}),
    })
  }
  const url = readNestedString(created.data, ['document', 'url']) ??
    readNestedString(created.data, ['url'])
  const title = readNestedString(created.data, ['document', 'title']) ??
    readNestedString(created.data, ['title']) ??
    input.title
  return {
    ...(documentId ? { documentId } : {}),
    title,
    ...(url ? { url } : {}),
    rawData: created.data,
  }
}

export async function appendDocText(input: {
  client: FeishuClient
  documentId: string
  content: string
  retryCounter?: { count: number }
}): Promise<FeishuEnvelope> {
  const children = contentToDocBlocks(input.content)
  if (children.length === 0) {
    return { code: 0, data: { skipped: true, reason: 'empty content' } }
  }
  const client = input.client as FeishuDocClient
  return withFeishuRetry(() => callFeishu(() => client.docx.documentBlockChildren.create({
    path: { document_id: input.documentId, block_id: input.documentId },
    data: {
      children,
    },
  })), {
    onRetry: (c, attempt, delayMs) => logFeishuRetry(c, attempt, delayMs, 'docx.append'),
    ...(input.retryCounter ? { retryCounter: input.retryCounter } : {}),
  })
}

// Feishu permission tiers (perm field):
//   view         — read-only.
//   edit         — read + write.
//   full_access  — read + write + manage collaborators ("拥有者" badge in the
//                  Feishu UI; can approve subsequent permission requests).
//
// member_type enum (Feishu drive.v1.permissions.members.create, verified
// 2026-05-12 via a field_violations response):
//   email, openid, unionid, openchat, opendepartmentid, userid, groupid,
//   wikispaceid, appid.
// We only need 'openid' (for the triggering user) and 'openchat' (for the
// entire group chat). The older 'chatid' value Feishu's docs once accepted
// is no longer in the enum and 4xx's with "field validation failed" — do
// not regress to it. The URL query `type` is the FILE type, which is
// always 'docx' for documents we just created via `createDoc`.
export async function grantUserPermission(input: {
  client: FeishuClient
  documentId: string
  openId: string
  perm: 'view' | 'edit' | 'full_access'
}): Promise<{ ok: true } | { ok: false; error: string; alreadyExists: boolean }> {
  return grantPermission({
    client: input.client,
    documentId: input.documentId,
    data: { member_type: 'openid', member_id: input.openId, perm: input.perm },
  })
}

export async function grantChatPermission(input: {
  client: FeishuClient
  documentId: string
  chatId: string
  perm: 'view' | 'edit' | 'full_access'
}): Promise<{ ok: true } | { ok: false; error: string; alreadyExists: boolean }> {
  return grantPermission({
    client: input.client,
    documentId: input.documentId,
    data: { member_type: 'openchat', member_id: input.chatId, perm: input.perm },
  })
}

async function grantPermission(input: {
  client: FeishuClient
  documentId: string
  data: { member_type: 'openid' | 'openchat'; member_id: string; perm: 'view' | 'edit' | 'full_access' }
}): Promise<{ ok: true } | { ok: false; error: string; alreadyExists: boolean }> {
  const client = input.client as FeishuDrivePermissionClient
  try {
    await callFeishu(() => client.drive.permissionMember.create({
      path: { token: input.documentId },
      params: { type: 'docx', need_notification: false },
      data: input.data,
    }))
    return { ok: true }
  } catch (error) {
    const c = classifyFeishuError(error)
    const message = c.agentMessage
    const alreadyExists = c.kind === 'already-exists'
    if (!alreadyExists) {
      process.stderr.write(
        `feishu permission grant failed: ${input.data.member_type}/${input.data.member_id} on docx ${input.documentId} (perm=${input.data.perm}): ${message}\n`,
      )
    }
    return { ok: false, error: message, alreadyExists }
  }
}

function contentToDocBlocks(content: string): Array<Record<string, unknown>> {
  return content
    .split(/\n{2,}/)
    .map(part => part.trim())
    .filter(Boolean)
    .slice(0, 50)
    .map(part => ({
      block_type: 2,
      text: {
        elements: [{
          text_run: {
            content: part.slice(0, 2000),
          },
        }],
      },
    }))
}

type FeishuDocClient = {
  docx: {
    document: {
      create(input: unknown): Promise<FeishuEnvelope>
      get(input: unknown): Promise<FeishuEnvelope>
      rawContent(input: unknown): Promise<FeishuEnvelope>
    }
    documentBlock: {
      list(input: unknown): Promise<FeishuEnvelope>
    }
    documentBlockChildren: {
      create(input: unknown): Promise<FeishuEnvelope>
    }
  }
}

type FeishuDrivePermissionClient = {
  drive: {
    permissionMember: {
      create(input: unknown): Promise<FeishuEnvelope>
    }
  }
}
