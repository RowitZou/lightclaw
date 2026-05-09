import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'

import type { Runtime } from '../../runtime/types.js'
import {
  fetchFeishuMediaPayload,
  fileNameFor,
  materializeFeishuMedia,
  unwrapResourceResponse,
} from './media.js'

function makeClient(payload: unknown): never {
  return {
    im: {
      messageResource: {
        get: async () => ({ code: 0, data: payload }),
      },
    },
  } as never
}

test('fetchFeishuMediaPayload returns buffered media metadata', async () => {
  const result = await fetchFeishuMediaPayload({
    client: makeClient(Buffer.from('image-bytes')),
    messageId: 'om_123',
    mediaKey: { kind: 'image', key: 'img_456' },
  })

  assert.ok(result)
  assert.equal(result.buffer.toString(), 'image-bytes')
  assert.equal(result.mimeType, 'image/jpeg')
  assert.equal(result.fileName, 'om_123-image.jpg')
})

test('fetchFeishuMediaPayload bufferizes SDK payload variants', async () => {
  const variants: unknown[] = [
    Buffer.from('a'),
    new Uint8Array([98]),
    Uint8Array.from([99]).buffer,
    Readable.from(['d']),
  ]

  const texts: string[] = []
  for (const payload of variants) {
    const result = await fetchFeishuMediaPayload({
      client: makeClient(payload),
      messageId: 'om_123',
      mediaKey: { kind: 'file', key: 'file_456', fileName: 'x.bin' },
    })
    assert.ok(result)
    texts.push(result.buffer.toString())
  }

  assert.deepEqual(texts, ['a', 'b', 'c', 'd'])
})

test('fetchFeishuMediaPayload unwraps Lark binary-endpoint wrapper { getReadableStream, ... }', async () => {
  // Lark SDK binary endpoints (im.messageResource.get etc.) return a
  // wrapper object instead of an envelope with `data`. Without the
  // unwrap step in fetchFeishuMediaPayload, bufferizePayload throws
  // "unsupported payload type" and the user sees [媒体下载失败].
  let streamCalled = false
  const wrapper = {
    writeFile: async () => undefined,
    headers: { 'content-type': 'image/jpeg' },
    getReadableStream: () => {
      streamCalled = true
      return Readable.from(['wrapper-bytes'])
    },
  }
  const client = {
    im: {
      messageResource: {
        get: async () => wrapper,
      },
    },
  } as never

  const result = await fetchFeishuMediaPayload({
    client,
    messageId: 'om_123',
    mediaKey: { kind: 'image', key: 'img_456' },
  })

  assert.ok(result)
  assert.equal(streamCalled, true)
  assert.equal(result.buffer.toString(), 'wrapper-bytes')
})

test('unwrapResourceResponse pulls stream from Lark wrapper, passes through plain payloads', () => {
  const stream = Readable.from(['x'])
  const wrapper = { getReadableStream: () => stream, writeFile: async () => undefined }
  assert.equal(unwrapResourceResponse(wrapper), stream)

  // Non-wrapper payloads pass through verbatim.
  const buf = Buffer.from('z')
  assert.equal(unwrapResourceResponse(buf), buf)
  assert.equal(unwrapResourceResponse(undefined), undefined)
  assert.equal(unwrapResourceResponse(null), null)
  // Object that has `getReadableStream` but it's not a function — pass through.
  const fake = { getReadableStream: 'not a function' }
  assert.equal(unwrapResourceResponse(fake), fake)
})

test('fetchFeishuMediaPayload returns null on SDK error envelope', async () => {
  const client = {
    im: {
      messageResource: {
        get: async () => ({ code: 1234, msg: 'permission denied' }),
      },
    },
  } as never

  const result = await fetchFeishuMediaPayload({
    client,
    messageId: 'om_123',
    mediaKey: { kind: 'image', key: 'img_456' },
  })

  assert.equal(result, null)
})

test('materializeFeishuMedia writes through runtime.fs.writeFile', async () => {
  const writes: Array<{ path: string; content: Buffer | string }> = []
  const runtime = {
    workspaceRoot: '/workspace',
    fs: {
      writeFile: async (path: string, content: Buffer | string) => {
        writes.push({ path, content })
      },
    },
  } as unknown as Runtime

  const result = await materializeFeishuMedia({
    payload: {
      buffer: Buffer.from('hello'),
      mimeType: 'image/jpeg',
      fileName: 'foo.jpg',
    },
    runtime,
    chatId: 'oc://chat',
  })

  assert.deepEqual(result, {
    path: '/workspace/.lightclaw/inbox/oc___chat/foo.jpg',
    mimeType: 'image/jpeg',
  })
  assert.equal(writes.length, 1)
  assert.equal(writes[0].path, '/workspace/.lightclaw/inbox/oc___chat/foo.jpg')
  assert.equal(Buffer.from(writes[0].content).toString(), 'hello')
})

test('materializeFeishuMedia returns null when runtime write fails', async () => {
  const runtime = {
    workspaceRoot: '/workspace',
    fs: {
      writeFile: async () => {
        throw new Error('disk full')
      },
    },
  } as unknown as Runtime

  const result = await materializeFeishuMedia({
    payload: {
      buffer: Buffer.from('hello'),
      mimeType: 'image/jpeg',
      fileName: 'foo.jpg',
    },
    runtime,
    chatId: 'oc_chat',
  })

  assert.equal(result, null)
})

test('fileNameFor prefers sanitized Feishu filenames', () => {
  assert.equal(
    fileNameFor('om_123', { kind: 'file', key: 'file_456', fileName: '../report final.pdf' }),
    '.._report_final.pdf',
  )
  assert.equal(fileNameFor('om_123', { kind: 'audio', key: 'audio_456' }), 'om_123-audio.opus')
})
