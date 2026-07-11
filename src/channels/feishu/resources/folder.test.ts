import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { FeishuClient } from '../client.js'
import { moveFile, renameFile } from './folder.js'

// 2026-07-10 prod regression suite: FeishuMove had NEVER succeeded in
// production (audit history: 16 failed / 0 success) because the move
// request put `type` in query params while Feishu's move API requires it
// in the request body, and the rename path called a drive.v1.file.update
// method the SDK does not even ship. These tests pin the real wire shapes.

type Call = { name: string; input: unknown }

function makeClient(overrides: {
  listQueue?: Array<Array<{ token: string; name: string; type: string }>>
} = {}): { client: FeishuClient; calls: Call[] } {
  const calls: Call[] = []
  const listQueue = overrides.listQueue ? [...overrides.listQueue] : []
  const client = {
    drive: {
      v1: {
        file: {
          move: async (input: unknown) => {
            calls.push({ name: 'drive.file.move', input })
            return { code: 0, data: {} }
          },
          createFolder: async (input: unknown) => {
            calls.push({ name: 'drive.file.createFolder', input })
            return { code: 0, data: { token: 'fld_new', name: 'renamed' } }
          },
          list: async (input: unknown) => {
            calls.push({ name: 'drive.file.list', input })
            const next = listQueue.length > 1 ? listQueue.shift()! : (listQueue[0] ?? [])
            return { code: 0, data: { files: next.map(f => ({ ...f, parent_token: 'fld_old' })) } }
          },
          delete: async (input: unknown) => {
            calls.push({ name: 'drive.file.delete', input })
            return { code: 0, data: {} }
          },
        },
      },
    },
    docx: {
      documentBlock: {
        patch: async (input: unknown) => {
          calls.push({ name: 'docx.documentBlock.patch', input })
          return { code: 0, data: {} }
        },
      },
    },
    sheets: {
      spreadsheet: {
        patch: async (input: unknown) => {
          calls.push({ name: 'sheets.spreadsheet.patch', input })
          return { code: 0, data: {} }
        },
      },
    },
  } as unknown as FeishuClient
  return { client, calls }
}

describe('moveFile wire shape', () => {
  it('sends type AND folder_token in the request body (not query params)', async () => {
    const { client, calls } = makeClient()
    await moveFile({ client, token: 'docA', type: 'docx', destFolderToken: 'fldB' })
    assert.equal(calls.length, 1)
    const input = calls[0]!.input as { path?: unknown; params?: unknown; data?: unknown }
    assert.deepEqual(input.path, { file_token: 'docA' })
    assert.deepEqual(input.data, { type: 'docx', folder_token: 'fldB' })
    assert.equal(input.params, undefined)
  })
})

describe('renameFile per-type dispatch', () => {
  it('renames a doc by patching the page block (block_id == document_id)', async () => {
    const { client, calls } = makeClient()
    const result = await renameFile({ client, token: 'docA', type: 'docx', name: 'new title' })
    assert.equal(result.newToken, undefined)
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.name, 'docx.documentBlock.patch')
    const input = calls[0]!.input as {
      path?: { document_id?: string; block_id?: string }
      data?: { update_text_elements?: { elements?: Array<{ text_run?: { content?: string } }> } }
    }
    assert.equal(input.path?.document_id, 'docA')
    assert.equal(input.path?.block_id, 'docA')
    assert.equal(input.data?.update_text_elements?.elements?.[0]?.text_run?.content, 'new title')
  })

  it('renames a sheet via spreadsheets PATCH title', async () => {
    const { client, calls } = makeClient()
    await renameFile({ client, token: 'sheetA', type: 'sheet', name: 'Q3 data' })
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.name, 'sheets.spreadsheet.patch')
    const input = calls[0]!.input as { path?: { spreadsheet_token?: string }; data?: { title?: string } }
    assert.equal(input.path?.spreadsheet_token, 'sheetA')
    assert.equal(input.data?.title, 'Q3 data')
  })

  it('rejects types Feishu cannot rename', async () => {
    const { client } = makeClient()
    await assert.rejects(
      renameFile({ client, token: 'fileA', type: 'file', name: 'x' }),
      /no rename API for drive item type "file"/,
    )
  })

  it('renames a folder by recreate + move children + delete drained original', async () => {
    // list #1: enumerate children; list #2+ (drain check): empty.
    const { client, calls } = makeClient({
      listQueue: [
        [{ token: 'docA', name: 'a.docx', type: 'docx' }, { token: 'fldSub', name: 'sub', type: 'folder' }],
        [],
      ],
    })
    const result = await renameFile({
      client,
      token: 'fld_old',
      type: 'folder',
      name: 'renamed',
      parentFolderToken: 'fld_parent',
      pollIntervalMs: 1,
    })
    assert.equal(result.newToken, 'fld_new')
    const names = calls.map(c => c.name)
    assert.deepEqual(names, [
      'drive.file.list',            // enumerate children
      'drive.file.createFolder',    // recreate under new name
      'drive.file.move',            // child docA
      'drive.file.move',            // child fldSub
      'drive.file.list',            // drain check
      'drive.file.delete',          // trash old folder
    ])
    const createInput = calls[1]!.input as { data?: { folder_token?: string; name?: string } }
    assert.deepEqual(createInput.data, { folder_token: 'fld_parent', name: 'renamed' })
    const moveInputs = calls.filter(c => c.name === 'drive.file.move')
      .map(c => (c.input as { data?: { type?: string; folder_token?: string } }).data)
    assert.deepEqual(moveInputs, [
      { type: 'docx', folder_token: 'fld_new' },
      { type: 'folder', folder_token: 'fld_new' },
    ])
    const deleteInput = calls.at(-1)!.input as { path?: { file_token?: string }; params?: { type?: string } }
    assert.equal(deleteInput.path?.file_token, 'fld_old')
    assert.equal(deleteInput.params?.type, 'folder')
  })

  it('never deletes the old folder while it still lists content', async () => {
    // Drain check keeps returning a straggler (e.g. an async folder move
    // that has not landed) — the old folder must be kept, not trashed.
    const { client, calls } = makeClient({
      listQueue: [
        [{ token: 'docA', name: 'a.docx', type: 'docx' }],
      ],
    })
    await assert.rejects(
      renameFile({
        client,
        token: 'fld_old',
        type: 'folder',
        name: 'renamed',
        parentFolderToken: 'fld_parent',
        pollIntervalMs: 1,
        maxPollAttempts: 2,
      }),
      /old folder was NOT deleted/,
    )
    assert.equal(calls.some(c => c.name === 'drive.file.delete'), false)
  })
})
