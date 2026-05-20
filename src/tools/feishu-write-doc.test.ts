import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import type { FeishuClient } from '../channels/feishu/client.js'
import type { FeishuCanonicalResource } from '../channels/feishu/resource-resolver.js'
import { setLightclawHomeOverride } from '../paths.js'
import type { PermissionApprover, PermissionAskInput } from '../permission/types.js'
import { createSessionContext, runWithSessionContext } from '../session-context.js'
import { feishuWriteDocTool, runFeishuWriteDoc } from './feishu-collab.js'

const client = {} as FeishuClient

let tmpHome = ''

type AuditRecord = {
  at: string
  userId?: string
  operation: string
  resource: Record<string, unknown>
  preview: string
  status: string
  error?: string | { kind: string; message: string; code?: number; logId?: string }
}

beforeEach(async () => {
  tmpHome = await mkdtemp(path.join(tmpdir(), 'lightclaw-feishu-write-doc-'))
  setLightclawHomeOverride(tmpHome)
})

afterEach(async () => {
  setLightclawHomeOverride(undefined)
  await rm(tmpHome, { recursive: true, force: true })
})

describe('FeishuWriteDoc tool', () => {
  it('appends to resolved doc URLs after write confirmation and records confirmed audit', async () => {
    let askInput: PermissionAskInput | undefined
    let appendArgs: unknown
    const result = await withFeishuSession({
      approver: {
        ask: async input => {
          askInput = input
          return { behavior: 'allow' }
        },
      },
      fn: () =>
        runFeishuWriteDoc(
          {
            url: 'https://example.feishu.cn/wiki/wikiToken',
            content: 'hello doc',
            mode: 'append',
          },
          {
            client,
            resolveResource: async input => {
              assert.deepEqual(input, { url: 'https://example.feishu.cn/wiki/wikiToken' })
              return canonical('docx', 'docFromWiki', { source: 'wiki.get_node' })
            },
            appendDoc: async input => {
              appendArgs = input
              return { code: 0, data: { revision_id: 7 } }
            },
          },
        ),
    })

    assert.equal(result.isError, undefined)
    assert.deepEqual(result.output, {
      document_id: 'docFromWiki',
      url: 'https://feishu.cn/docx/docFromWiki',
      appended_chars: 9,
      mode: 'append',
      data: { revision_id: 7 },
    })
    assert.deepEqual(appendArgs, {
      client,
      documentId: 'docFromWiki',
      content: 'hello doc',
      retryCounter: { count: 0 },
    })
    assert.equal(askInput?.toolName, 'FeishuWriteConfirm')
    assert.equal(askInput?.riskLevel, 'write')
    assert.match(askInput?.inputPreview ?? '', /append-doc/)

    const records = await readAuditRecords()
    assert.equal(records.length, 1)
    assert.equal(records[0].userId, 'alice')
    assert.equal(records[0].operation, 'append-doc')
    assert.equal(records[0].status, 'confirmed')
    assert.deepEqual(records[0].resource, {
      documentId: 'docFromWiki',
      mode: 'append',
    })
    assert.match(records[0].preview, /Append 9 chars/)
  })

  it('records denied audit and skips SDK calls when confirmation is denied', async () => {
    let appendCalled = false
    await assert.rejects(
      withFeishuSession({
        approver: {
          ask: async () => ({ behavior: 'deny', reason: 'needs owner approval' }),
        },
        fn: () =>
          runFeishuWriteDoc(
            {
              document_id: 'docDirect',
              content: 'denied',
              mode: 'append',
            },
            {
              client,
              appendDoc: async () => {
                appendCalled = true
                throw new Error('should not call sdk')
              },
            },
          ),
      }),
      /Feishu write denied: needs owner approval/,
    )

    assert.equal(appendCalled, false)
    const records = await readAuditRecords()
    assert.equal(records.length, 1)
    assert.equal(records[0].operation, 'append-doc')
    assert.equal(records[0].status, 'denied')
    assert.equal(records[0].error, 'needs owner approval')
  })

  it('records failed audit and rethrows SDK errors after confirmation', async () => {
    await assert.rejects(
      withFeishuSession({
        approver: {
          ask: async () => ({ behavior: 'allow' }),
        },
        fn: () =>
          runFeishuWriteDoc(
            {
              document_id: 'docBroken',
              content: 'will fail',
              mode: 'append',
            },
            {
              client,
              appendDoc: async () => {
                throw new Error('ScopeAccessDenied')
              },
            },
          ),
      }),
      /ScopeAccessDenied/,
    )

    const records = await readAuditRecords()
    assert.equal(records.length, 2)
    assert.equal(records[0].status, 'confirmed')
    assert.equal(records[1].status, 'failed')
    assert.equal(typeof records[1].error, 'object')
    assert.equal((records[1].error as { kind: string }).kind, 'unknown')
    assert.match((records[1].error as { message: string }).message, /ScopeAccessDenied/)
  })

  it('appends markdown with structured action and audit operation', async () => {
    let askInput: PermissionAskInput | undefined
    let appendArgs: unknown
    const result = await withFeishuSession({
      approver: {
        ask: async input => {
          askInput = input
          return { behavior: 'allow' }
        },
      },
      fn: () =>
        runFeishuWriteDoc(
          {
            document_id: 'docMarkdown',
            action: 'append_markdown',
            content: '# Title\n\n- item',
          },
          {
            client,
            appendMarkdown: async input => {
              appendArgs = input
              return {
                documentId: input.documentId,
                action: 'append_markdown',
                markdown_chars: input.markdown.length,
                blocks_added: 2,
                data: { children: [{ block_id: 'b1' }] },
              }
            },
          },
        ),
    })

    assert.equal(result.isError, undefined)
    assert.deepEqual(result.output, {
      document_id: 'docMarkdown',
      url: 'https://feishu.cn/docx/docMarkdown',
      action: 'append_markdown',
      markdown_chars: 15,
      blocks_added: 2,
      data: { children: [{ block_id: 'b1' }] },
    })
    assert.deepEqual(appendArgs, {
      client,
      documentId: 'docMarkdown',
      markdown: '# Title\n\n- item',
      retryCounter: { count: 0 },
    })
    assert.equal(askInput?.toolName, 'FeishuWriteConfirm')
    assert.match(askInput?.inputPreview ?? '', /append-doc-markdown/)

    const records = await readAuditRecords()
    assert.equal(records[0].operation, 'append-doc-markdown')
    assert.deepEqual(records[0].resource, {
      documentId: 'docMarkdown',
      action: 'append_markdown',
    })
  })

  it('uses one-shot replace confirmation for replace_markdown', async () => {
    let askInput: PermissionAskInput | undefined
    const result = await withFeishuSession({
      approver: {
        ask: async input => {
          askInput = input
          return { behavior: 'allow' }
        },
      },
      fn: () =>
        runFeishuWriteDoc(
          {
            document_id: 'docReplace',
            action: 'replace_markdown',
            content: '# New',
          },
          {
            client,
            replaceMarkdown: async input => ({
              documentId: input.documentId,
              action: 'replace_markdown',
              markdown_chars: input.markdown.length,
              blocks_deleted: 3,
              blocks_added: 1,
            }),
          },
        ),
    })

    assert.equal(result.isError, undefined)
    assert.deepEqual(result.output, {
      document_id: 'docReplace',
      url: 'https://feishu.cn/docx/docReplace',
      action: 'replace_markdown',
      markdown_chars: 5,
      blocks_added: 1,
      blocks_deleted: 3,
    })
    assert.equal(askInput?.toolName, 'FeishuReplaceDocConfirm')
    assert.match(askInput?.inputPreview ?? '', /replace-doc/)
  })

  it('updates and deletes blocks through dedicated actions', async () => {
    const updated = await withFeishuSession({
      approver: { ask: async () => ({ behavior: 'allow' }) },
      fn: () =>
        runFeishuWriteDoc(
          {
            document_id: 'docBlocks',
            action: 'update_block_text',
            block_id: 'block1',
            content: 'new text',
          },
          {
            client,
            updateBlockText: async input => ({
              documentId: input.documentId,
              blockId: input.blockId,
              action: 'update_block_text',
            }),
          },
        ),
    })
    assert.deepEqual(updated.output, {
      document_id: 'docBlocks',
      url: 'https://feishu.cn/docx/docBlocks',
      action: 'update_block_text',
      block_id: 'block1',
    })

    let deleteAsk: PermissionAskInput | undefined
    const deleted = await withFeishuSession({
      approver: {
        ask: async input => {
          deleteAsk = input
          return { behavior: 'allow' }
        },
      },
      fn: () =>
        runFeishuWriteDoc(
          {
            document_id: 'docBlocks',
            action: 'delete_block',
            block_id: 'block1',
          },
          {
            client,
            deleteBlock: async input => ({
              documentId: input.documentId,
              blockId: input.blockId,
              action: 'delete_block',
            }),
          },
        ),
    })
    assert.deepEqual(deleted.output, {
      document_id: 'docBlocks',
      url: 'https://feishu.cn/docx/docBlocks',
      action: 'delete_block',
      block_id: 'block1',
    })
    assert.equal(deleteAsk?.toolName, 'FeishuWriteConfirm')
    assert.deepEqual(deleteAsk?.suggestedRules, [{ toolName: 'FeishuWriteConfirm' }])
  })

  it('short-circuits doc block deletion when a FeishuWriteConfirm allow rule is persisted', async () => {
    await mkdir(path.join(tmpHome, 'identity', 'per-user', 'alice'), { recursive: true })
    await writeFile(
      path.join(tmpHome, 'identity', 'per-user', 'alice', 'permissions.json'),
      JSON.stringify({ allow: ['FeishuWriteConfirm'] }, null, 2),
      'utf8',
    )

    let askCount = 0
    const deleted = await withFeishuSession({
      approver: {
        ask: async () => {
          askCount += 1
          return { behavior: 'allow' }
        },
      },
      fn: () =>
        runFeishuWriteDoc(
          {
            document_id: 'docBlocks',
            action: 'delete_block',
            block_id: 'block1',
          },
          {
            client,
            deleteBlock: async input => ({
              documentId: input.documentId,
              blockId: input.blockId,
              action: 'delete_block',
            }),
          },
        ),
    })

    assert.equal(askCount, 0, 'approver.ask must not be called when FeishuWriteConfirm covers block deletion')
    assert.deepEqual(deleted.output, {
      document_id: 'docBlocks',
      url: 'https://feishu.cn/docx/docBlocks',
      action: 'delete_block',
      block_id: 'block1',
    })
    const records = await readAuditRecords()
    assert.equal(records.length, 1)
    assert.equal(records[0].operation, 'delete-doc-block')
    assert.equal(records[0].status, 'confirmed')
  })

  it('creates and mutates doc tables with dedicated audit operations', async () => {
    const created = await withFeishuSession({
      approver: { ask: async () => ({ behavior: 'allow' }) },
      fn: () =>
        runFeishuWriteDoc(
          {
            document_id: 'docTable',
            action: 'create_table_with_values',
            values: [['A', 'B'], ['1', '2']],
          },
          {
            client,
            createTableWithValues: async input => ({
              documentId: input.documentId,
              action: 'create_table_with_values',
              tableBlockId: 'tbl1',
              rowSize: input.rowSize ?? input.values.length,
              columnSize: input.columnSize ?? input.values[0]?.length,
              cellsWritten: 4,
            }),
          },
        ),
    })
    assert.deepEqual(created.output, {
      document_id: 'docTable',
      url: 'https://feishu.cn/docx/docTable',
      action: 'create_table_with_values',
      table_block_id: 'tbl1',
      row_size: 2,
      column_size: 2,
      cells_written: 4,
    })
    let records = await readAuditRecords()
    assert.equal(records[0].operation, 'create-doc-table-with-values')

    let askInput: PermissionAskInput | undefined
    const deletedRows = await withFeishuSession({
      approver: {
        ask: async input => {
          askInput = input
          return { behavior: 'allow' }
        },
      },
      fn: () =>
        runFeishuWriteDoc(
          {
            document_id: 'docTable2',
            action: 'delete_table_rows',
            table_block_id: 'tbl2',
            row_start: 1,
            row_count: 2,
          },
          {
            client,
            deleteTableRows: async input => ({
              documentId: input.documentId,
              action: 'delete_table_rows',
              tableBlockId: input.tableBlockId,
              rowsDeleted: input.rowCount,
            }),
          },
        ),
    })
    assert.deepEqual(deletedRows.output, {
      document_id: 'docTable2',
      url: 'https://feishu.cn/docx/docTable2',
      action: 'delete_table_rows',
      table_block_id: 'tbl2',
      rows_deleted: 2,
    })
    assert.equal(askInput?.toolName, 'FeishuTableEditConfirm')
    records = await readAuditRecords()
    assert.equal(records.at(-1)?.operation, 'delete-doc-table-rows')
  })

  it('short-circuits doc table content edits when a FeishuTableEditConfirm allow rule is persisted', async () => {
    await mkdir(path.join(tmpHome, 'identity', 'per-user', 'alice'), { recursive: true })
    await writeFile(
      path.join(tmpHome, 'identity', 'per-user', 'alice', 'permissions.json'),
      JSON.stringify({ allow: ['FeishuTableEditConfirm'] }, null, 2),
      'utf8',
    )
    let askCount = 0
    const result = await withFeishuSession({
      approver: {
        ask: async () => {
          askCount += 1
          return { behavior: 'allow' }
        },
      },
      fn: () =>
        runFeishuWriteDoc(
          {
            document_id: 'docTableAllowed',
            action: 'delete_table_columns',
            table_block_id: 'tblAllowed',
            column_start: 0,
            column_count: 1,
          },
          {
            client,
            deleteTableColumns: async input => ({
              documentId: input.documentId,
              action: 'delete_table_columns',
              tableBlockId: input.tableBlockId,
              columnsDeleted: input.columnCount,
            }),
          },
        ),
    })

    assert.equal(askCount, 0, 'approver.ask must not be called when covered by FeishuTableEditConfirm')
    assert.deepEqual(result.output, {
      document_id: 'docTableAllowed',
      url: 'https://feishu.cn/docx/docTableAllowed',
      action: 'delete_table_columns',
      table_block_id: 'tblAllowed',
      columns_deleted: 1,
    })
    const records = await readAuditRecords()
    assert.equal(records.at(-1)?.operation, 'delete-doc-table-columns')
    assert.equal(records.at(-1)?.status, 'confirmed')
  })

  it('uploads doc images and files with dedicated upload confirmation', async () => {
    let askInput: PermissionAskInput | undefined
    let readArgs: unknown
    let uploadArgs: unknown
    const imageResult = await withFeishuSession({
      approver: {
        ask: async input => {
          askInput = input
          return { behavior: 'allow' }
        },
      },
      fn: () =>
        runFeishuWriteDoc(
          {
            document_id: 'docMedia',
            action: 'upload_image',
            file_path: '/workspace/chart.png',
            filename: 'chart.png',
            parent_block_id: 'parent1',
            index: 3,
            media_max_mb: 5,
          },
          {
            client,
            readLocalMedia: async (filePath, displayName, options) => {
              readArgs = { filePath, displayName, options }
              return { content: Buffer.from('image-bytes'), name: displayName ?? 'chart.png' }
            },
            uploadImage: async input => {
              uploadArgs = input
              return {
                documentId: input.documentId,
                action: 'upload_image',
                blockId: 'img1',
                fileToken: 'tok_img',
                fileName: input.fileName,
                size: input.content.byteLength,
              }
            },
          },
        ),
    })

    assert.deepEqual(imageResult.output, {
      document_id: 'docMedia',
      url: 'https://feishu.cn/docx/docMedia',
      action: 'upload_image',
      block_id: 'img1',
      file_token: 'tok_img',
      file_name: 'chart.png',
      size: 11,
    })
    assert.equal(askInput?.toolName, 'FeishuUploadConfirm')
    assert.match(askInput?.inputPreview ?? '', /upload-doc-image/)
    assert.deepEqual(readArgs, {
      filePath: '/workspace/chart.png',
      displayName: 'chart.png',
      options: { maxBytes: 5 * 1024 * 1024, imageOnly: true },
    })
    assert.deepEqual(uploadArgs, {
      client,
      documentId: 'docMedia',
      content: Buffer.from('image-bytes'),
      fileName: 'chart.png',
      parentBlockId: 'parent1',
      index: 3,
      retryCounter: { count: 0 },
    })

    const fileResult = await withFeishuSession({
      approver: { ask: async () => ({ behavior: 'allow' }) },
      fn: () =>
        runFeishuWriteDoc(
          {
            document_id: 'docMedia',
            action: 'upload_file',
            file_path: '/workspace/report.pdf',
          },
          {
            client,
            readLocalMedia: async () => ({ content: Buffer.from('pdf'), name: 'report.pdf' }),
            uploadDocFile: async input => ({
              documentId: input.documentId,
              action: 'upload_file',
              fileToken: 'tok_file',
              fileName: input.fileName,
              size: input.content.byteLength,
              note: 'uploaded as docx_file media',
            }),
          },
        ),
    })
    assert.deepEqual(fileResult.output, {
      document_id: 'docMedia',
      url: 'https://feishu.cn/docx/docMedia',
      action: 'upload_file',
      file_token: 'tok_file',
      file_name: 'report.pdf',
      size: 3,
      note: 'uploaded as docx_file media',
    })

    const records = await readAuditRecords()
    assert.equal(records[0].operation, 'upload-doc-image')
    assert.equal(records[1].operation, 'upload-doc-file')
  })

  it('short-circuits doc media upload when a FeishuUploadConfirm allow rule is persisted', async () => {
    await mkdir(path.join(tmpHome, 'identity', 'per-user', 'alice'), { recursive: true })
    await writeFile(
      path.join(tmpHome, 'identity', 'per-user', 'alice', 'permissions.json'),
      JSON.stringify({ allow: ['FeishuUploadConfirm'] }, null, 2),
      'utf8',
    )
    let askCount = 0
    const result = await withFeishuSession({
      approver: {
        ask: async () => {
          askCount += 1
          return { behavior: 'allow' }
        },
      },
      fn: () =>
        runFeishuWriteDoc(
          {
            document_id: 'docMediaAllowed',
            action: 'upload_image',
            file_path: '/workspace/chart.png',
            filename: 'chart.png',
          },
          {
            client,
            readLocalMedia: async () => ({ content: Buffer.from('image-bytes'), name: 'chart.png' }),
            uploadImage: async input => ({
              documentId: input.documentId,
              action: 'upload_image',
              blockId: 'imgAllowed',
              fileToken: 'tok_allowed',
              fileName: input.fileName,
              size: input.content.byteLength,
            }),
          },
        ),
    })

    assert.equal(askCount, 0, 'approver.ask must not be called when upload is covered by FeishuUploadConfirm')
    assert.deepEqual(result.output, {
      document_id: 'docMediaAllowed',
      url: 'https://feishu.cn/docx/docMediaAllowed',
      action: 'upload_image',
      block_id: 'imgAllowed',
      file_token: 'tok_allowed',
      file_name: 'chart.png',
      size: 11,
    })
    const records = await readAuditRecords()
    assert.equal(records.length, 1)
    assert.equal(records[0].operation, 'upload-doc-image')
    assert.equal(records[0].status, 'confirmed')
  })

  it('enforces input invariant and Feishu tool metadata', () => {
    assert.equal(feishuWriteDocTool.inputSchema?.safeParse({ content: 'x' }).success, false)
    assert.equal(
      feishuWriteDocTool.inputSchema?.safeParse({
        url: 'https://example.feishu.cn/docx/doc1',
        document_id: 'doc1',
        content: 'x',
      }).success,
      false,
    )
    assert.deepEqual(feishuWriteDocTool.channelScope, ['feishu'])
    assert.equal(feishuWriteDocTool.shouldDefer, true)
    assert.match(feishuWriteDocTool.searchHint ?? '', /append/)
    assert.equal(
      feishuWriteDocTool.inputSchema?.safeParse({
        document_id: 'doc1',
        action: 'upload_image',
        file_path: '/workspace/chart.png',
      }).success,
      true,
    )
  })

  it('rejects URLs whose canonical resource is not a doc before confirmation', async () => {
    let askCalled = false
    await assert.rejects(
      withFeishuSession({
        approver: {
          ask: async () => {
            askCalled = true
            return { behavior: 'allow' }
          },
        },
        fn: () =>
          runFeishuWriteDoc(
            {
              url: 'https://example.feishu.cn/sheets/sheetToken',
              content: 'wrong target',
              mode: 'append',
            },
            {
              client,
              resolveResource: async () => canonical('sheet', 'sheetToken'),
            },
          ),
      }),
      /Expected Feishu docx\/doc/,
    )
    assert.equal(askCalled, false)
  })
})

async function withFeishuSession<T>(input: {
  approver: PermissionApprover
  fn: () => Promise<T>
}): Promise<T> {
  const ctx = createSessionContext({
    sessionId: 'feishu:dm:chat1',
    channel: 'feishu',
    cwd: tmpHome,
    model: 'test-model',
    sessionsDir: path.join(tmpHome, 'sessions'),
    memoryDir: path.join(tmpHome, 'memory'),
    currentUserId: 'alice',
    permissionMode: 'default',
    permissionApprover: input.approver,
  })
  return runWithSessionContext(ctx, input.fn)
}

async function readAuditRecords(): Promise<AuditRecord[]> {
  const dir = path.join(tmpHome, 'audit', 'feishu-writes')
  const files = await readdir(dir)
  assert.equal(files.length, 1)
  const content = await readFile(path.join(dir, files[0]), 'utf8')
  return content
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as AuditRecord)
}

function canonical(
  resourceType: FeishuCanonicalResource['resourceType'],
  token: string | undefined,
  extra: Partial<Pick<FeishuCanonicalResource, 'source' | 'sheetId' | 'range'>> = {},
): FeishuCanonicalResource {
  return {
    input: {
      resourceType: resourceType === 'sheet' ? 'sheet' : resourceType,
      token: token ?? 'inputToken',
    },
    canonical: {
      resourceType,
      ...(token ? { token } : {}),
      source: extra.source ?? 'url',
    },
    resourceType,
    ...(token ? { canonicalToken: token } : {}),
    source: extra.source ?? 'url',
    ...(extra.sheetId ? { sheetId: extra.sheetId } : {}),
    ...(extra.range ? { range: extra.range } : {}),
    capabilities: capabilities(resourceType),
  }
}

function capabilities(resourceType: FeishuCanonicalResource['resourceType']): FeishuCanonicalResource['capabilities'] {
  if (resourceType === 'sheet') {
    return { readableWith: ['FeishuRead'], writableWith: ['FeishuWriteSheet'] }
  }
  if (resourceType === 'docx') {
    return { readableWith: ['FeishuRead'], writableWith: ['FeishuCreateFile', 'FeishuWriteDoc'] }
  }
  if (resourceType === 'doc') {
    return { readableWith: ['FeishuRead'], writableWith: ['FeishuWriteDoc'] }
  }
  return { readableWith: [], writableWith: [] }
}
