import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { FeishuClient } from '../client.js'
import { uploadDocFile, uploadDocImage } from './doc.js'

describe('Feishu doc media uploads', () => {
  it('creates an image block, uploads docx_image media, then patches the token', async () => {
    const calls: Array<{ name: string; input: unknown }> = []
    const client = {
      docx: {
        documentBlockChildren: {
          create: async (input: unknown) => {
            calls.push({ name: 'children.create', input })
            return { code: 0, data: { children: [{ block_type: 27, block_id: 'img1' }] } }
          },
          get: async () => ({ code: 0, data: { items: [{ block_id: 'img1' }] } }),
          batchDelete: async (input: unknown) => {
            calls.push({ name: 'children.batchDelete', input })
            return { code: 0, data: {} }
          },
        },
        documentBlock: {
          list: async () => ({ code: 0, data: { items: [] } }),
          get: async () => ({ code: 0, data: { block: { block_id: 'img1', parent_id: 'doc1' } } }),
          patch: async (input: unknown) => {
            calls.push({ name: 'block.patch', input })
            return { code: 0, data: { patched: true } }
          },
        },
        document: {
          create: async () => ({ code: 0 }),
          get: async () => ({ code: 0 }),
          rawContent: async () => ({ code: 0 }),
          convert: async () => ({ code: 0 }),
        },
        documentBlockDescendant: {
          create: async () => ({ code: 0 }),
        },
      },
      drive: {
        media: {
          uploadAll: async (input: unknown) => {
            calls.push({ name: 'media.uploadAll', input })
            return { file_token: 'media_tok_1' }
          },
        },
      },
    } as unknown as FeishuClient

    const result = await uploadDocImage({
      client,
      documentId: 'doc1',
      content: Buffer.from('png-bytes'),
      fileName: 'chart.png',
      parentBlockId: 'parent1',
      index: 2,
    })

    assert.equal(result.action, 'upload_image')
    assert.equal(result.blockId, 'img1')
    assert.equal(result.fileToken, 'media_tok_1')
    assert.equal(calls[0].name, 'children.create')
    assert.deepEqual(calls[0].input, {
      path: { document_id: 'doc1', block_id: 'parent1' },
      params: { document_revision_id: -1 },
      data: { children: [{ block_type: 27, image: {} }], index: 2 },
    })
    assert.equal(calls[1].name, 'media.uploadAll')
    assert.deepEqual(calls[1].input, {
      data: {
        file_name: 'chart.png',
        parent_type: 'docx_image',
        parent_node: 'img1',
        size: 9,
        file: Buffer.from('png-bytes'),
        extra: JSON.stringify({ drive_route_token: 'doc1' }),
      },
    })
    assert.equal(calls[2].name, 'block.patch')
    assert.deepEqual(calls[2].input, {
      path: { document_id: 'doc1', block_id: 'img1' },
      data: { replace_image: { token: 'media_tok_1' } },
    })
  })

  it('rejects non-image upload_image input before creating a block', async () => {
    let created = false
    const client = {
      docx: {
        documentBlockChildren: {
          create: async () => {
            created = true
            return { code: 0, data: { children: [] } }
          },
        },
      },
      drive: { media: { uploadAll: async () => ({ file_token: 'tok' }) } },
    } as unknown as FeishuClient

    await assert.rejects(
      uploadDocImage({
        client,
        documentId: 'doc1',
        content: Buffer.from('pdf'),
        fileName: 'paper.pdf',
      }),
      /Unsupported image extension/,
    )
    assert.equal(created, false)
  })

  it('uploads generic files as docx_file media without creating a visible block', async () => {
    let uploadInput: unknown
    const client = {
      drive: {
        media: {
          uploadAll: async (input: unknown) => {
            uploadInput = input
            return { data: { file_token: 'file_tok_1' } }
          },
        },
      },
    } as unknown as FeishuClient

    const result = await uploadDocFile({
      client,
      documentId: 'doc1',
      content: Buffer.from('report'),
      fileName: 'report.pdf',
    })

    assert.equal(result.action, 'upload_file')
    assert.equal(result.fileToken, 'file_tok_1')
    assert.match(result.note ?? '', /docx_file media/)
    assert.deepEqual(uploadInput, {
      data: {
        file_name: 'report.pdf',
        parent_type: 'docx_file',
        parent_node: 'doc1',
        size: 6,
        file: Buffer.from('report'),
      },
    })
  })
})
