import fs from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import type * as lark from '@larksuiteoapi/node-sdk'

import type { ParsedMediaKey } from './bot-content.js'

export type DownloadedMedia = {
  path: string
  mimeType: string
}

export async function downloadFeishuMedia(input: {
  client: lark.Client
  messageId: string
  mediaKey: ParsedMediaKey
  mediaDir: string
  chatId: string
}): Promise<DownloadedMedia | null> {
  const sdkType = input.mediaKey.kind === 'image' ? 'image' : 'file'
  try {
    const resp = await input.client.im.messageResource.get({
      path: {
        message_id: input.messageId,
        file_key: input.mediaKey.key,
      },
      params: { type: sdkType },
    } as never)
    const envelope = resp as unknown as {
      code?: number
      msg?: string
      data?: unknown
    }
    if (typeof envelope.code === 'number' && envelope.code !== 0) {
      process.stderr.write(
        `feishu media: get failed code=${envelope.code} msg=${envelope.msg ?? ''}\n`,
      )
      return null
    }

    const dir = path.join(input.mediaDir, sanitize(input.chatId))
    await fs.mkdir(dir, { recursive: true })
    const fileName = fileNameFor(input.messageId, input.mediaKey)
    const destPath = path.join(dir, fileName)
    await writePayload(envelope.data ?? resp, destPath)
    return {
      path: destPath,
      mimeType: inferMime(input.mediaKey),
    }
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    process.stderr.write(
      `feishu media: download error key=${input.mediaKey.key}: ${text}\n`,
    )
    return null
  }
}

function fileNameFor(messageId: string, key: ParsedMediaKey): string {
  const ext = inferExt(key)
  const rawName = key.fileName?.trim()
  if (rawName) {
    return sanitize(rawName)
  }
  return sanitize(`${messageId}-${key.kind}${ext}`)
}

function inferExt(key: ParsedMediaKey): string {
  if (key.kind === 'image') return '.jpg'
  if (key.kind === 'sticker') return '.png'
  if (key.kind === 'audio') return '.opus'
  if (key.kind === 'media') return '.mp4'
  if (key.fileName) {
    const dotted = key.fileName.lastIndexOf('.')
    return dotted >= 0 ? key.fileName.slice(dotted) : '.bin'
  }
  return '.bin'
}

function inferMime(key: ParsedMediaKey): string {
  if (key.kind === 'image') return 'image/jpeg'
  if (key.kind === 'sticker') return 'image/png'
  if (key.kind === 'audio') return 'audio/opus'
  if (key.kind === 'media') return 'video/mp4'
  return 'application/octet-stream'
}

async function writePayload(payload: unknown, destPath: string): Promise<void> {
  if (Buffer.isBuffer(payload)) {
    await fs.writeFile(destPath, payload)
    return
  }
  if (payload instanceof Uint8Array) {
    await fs.writeFile(destPath, Buffer.from(payload))
    return
  }
  if (payload instanceof ArrayBuffer) {
    await fs.writeFile(destPath, Buffer.from(payload))
    return
  }
  if (payload instanceof Readable) {
    await pipeline(payload, await fs.open(destPath, 'w').then(handle => {
      const stream = handle.createWriteStream()
      stream.once('close', () => void handle.close())
      return stream
    }))
    return
  }
  if (payload && typeof (payload as { pipe?: unknown }).pipe === 'function') {
    await pipeline(payload as NodeJS.ReadableStream, await fs.open(destPath, 'w').then(handle => {
      const stream = handle.createWriteStream()
      stream.once('close', () => void handle.close())
      return stream
    }))
    return
  }
  throw new Error('unsupported payload type from Feishu messageResource.get')
}

function sanitize(input: string): string {
  const value = input.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 120)
  return value || 'media'
}
