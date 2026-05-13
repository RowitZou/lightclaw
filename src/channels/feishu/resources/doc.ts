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
  rawData?: unknown
}

export async function readDocPlainText(input: {
  client: FeishuClient
  documentId: string
  maxChars: number
}): Promise<FeishuDocReadResult> {
  const client = input.client as FeishuDocClient
  const [info, raw] = await Promise.all([
    callFeishu(() => client.docx.document.get({ path: { document_id: input.documentId } })),
    callFeishu(() => client.docx.document.rawContent({ path: { document_id: input.documentId } })),
  ])
  const title = readNestedString(info.data, ['document', 'title']) ??
    readNestedString(info.data, ['title'])
  const content = readNestedString(raw.data, ['content']) ??
    readNestedString(raw.data, ['document', 'content']) ??
    ''
  const clipped = truncate(content, input.maxChars)
  return {
    documentId: input.documentId,
    ...(title ? { title } : {}),
    content: clipped.value,
    truncated: clipped.truncated,
    ...(content ? {} : { rawData: raw.data }),
  }
}

export async function createDoc(input: {
  client: FeishuClient
  title: string
  content?: string
  folderToken?: string
}): Promise<FeishuDocCreateResult> {
  const client = input.client as FeishuDocClient
  const created = await withFeishuRetry(() => callFeishu(() => client.docx.document.create({
    data: {
      title: input.title,
      ...(input.folderToken ? { folder_token: input.folderToken } : {}),
    },
  })), { onRetry: (c, attempt, delayMs) => logFeishuRetry(c, attempt, delayMs, 'docx.create') })
  const documentId = readNestedString(created.data, ['document', 'document_id']) ??
    readNestedString(created.data, ['document_id'])
  if (documentId && input.content?.trim()) {
    await appendDocText({
      client: input.client,
      documentId,
      content: input.content,
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
  })), { onRetry: (c, attempt, delayMs) => logFeishuRetry(c, attempt, delayMs, 'docx.append') })
}

// Feishu permission tiers (perm field):
//   view         — read-only.
//   edit         — read + write.
//   full_access  — read + write + manage collaborators ("拥有者" badge in the
//                  Feishu UI; can approve subsequent permission requests).
//
// member_type enum (Feishu drive.v1.permissions.members.create, verified
// 2026-05-12 via field_violations response on code=99992402):
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
