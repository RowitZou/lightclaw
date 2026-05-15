import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { FeishuClient } from '../client.js'
import { uploadDriveFile } from './file-upload.js'

describe('uploadDriveFile', () => {
  it('accepts the SDK uploadAll root-level file_token response', async () => {
    let uploadPayload: unknown
    const client = {
      drive: {
        v1: {
          file: {
            uploadAll: async (payload: unknown) => {
              uploadPayload = payload
              return { file_token: 'fileSmall' }
            },
          },
        },
      },
    } as unknown as FeishuClient

    const result = await uploadDriveFile({
      client,
      parentFolderToken: 'folder1',
      name: 'small.txt',
      content: Buffer.from('hello'),
    })

    assert.deepEqual(result, { fileToken: 'fileSmall', size: 5, chunks: 1 })
    assert.deepEqual(uploadPayload, {
      data: {
        file_name: 'small.txt',
        parent_type: 'explorer',
        parent_node: 'folder1',
        size: 5,
        file: Buffer.from('hello'),
      },
    })
  })

  it('accepts AxiosResponse-wrapped uploadPrepare/uploadFinish envelopes', async () => {
    const content = Buffer.alloc(19 * 1024 * 1024 + 1, 7)
    const parts: Array<{ seq: number; size: number }> = []
    const client = {
      drive: {
        v1: {
          file: {
            uploadPrepare: async () => ({
              data: {
                code: 0,
                data: {
                  upload_id: 'upload123',
                  block_size: content.byteLength,
                  block_num: 1,
                },
              },
            }),
            uploadPart: async (payload: { data: { seq: number; size: number } }) => {
              parts.push({ seq: payload.data.seq, size: payload.data.size })
              return { data: { code: 0, data: {} } }
            },
            uploadFinish: async () => ({
              data: {
                code: 0,
                data: {
                  file_token: 'fileChunked',
                },
              },
            }),
          },
        },
      },
    } as unknown as FeishuClient

    const result = await uploadDriveFile({
      client,
      parentFolderToken: 'folder2',
      name: 'large.bin',
      content,
    })

    assert.deepEqual(result, { fileToken: 'fileChunked', size: content.byteLength, chunks: 1 })
    assert.deepEqual(parts, [{ seq: 0, size: content.byteLength }])
  })
})
