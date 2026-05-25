import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'

import type * as lark from '@larksuiteoapi/node-sdk'

import type { Runtime } from '../../runtime/types.js'
import type { ParsedMediaKey } from './bot-content.js'
import { formatFeishuErrorForLog } from './resources/errors.js'

export type FeishuMediaPayload = {
  buffer: Buffer
  mimeType: string
  fileName: string
}

export type MaterializedFeishuMedia = {
  path: string
  mimeType: string
}

export async function fetchFeishuMediaPayload(input: {
  client: lark.Client
  messageId: string
  mediaKey: ParsedMediaKey
}): Promise<FeishuMediaPayload | null> {
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

    const buffer = await bufferizePayload(unwrapResourceResponse(envelope.data ?? resp))
    return {
      buffer,
      mimeType: inferMime(input.mediaKey),
      fileName: fileNameFor(input.messageId, input.mediaKey),
    }
  } catch (error) {
    process.stderr.write(
      `feishu media: download error key=${input.mediaKey.key}: ${formatFeishuErrorForLog(error, 'im.messageResource.get')}\n`,
    )
    return null
  }
}

export async function materializeFeishuMedia(input: {
  payload: FeishuMediaPayload
  runtime: Runtime
  chatId: string
}): Promise<MaterializedFeishuMedia | null> {
  const destPath = `${input.runtime.workspaceRoot}/.lightclaw/inbox/${sanitize(input.chatId)}/${input.payload.fileName}`
  try {
    // Opportunistic fast path: when the runtime exposes a host-side bind mount
    // (RlaunchRuntime gpfs/virtiofs today), write directly via host fs and skip
    // the per-32KB exec round-trips that a multi-MB image would otherwise pay
    // through brainctl. Returns null when unsupported; we transparently fall
    // back to writeFile() so this is always safe to attempt first.
    const fastWrite = input.runtime.fs.writeFileViaHostMount
    if (fastWrite) {
      const result = await fastWrite.call(input.runtime.fs, destPath, input.payload.buffer)
      if (result?.ok) {
        return {
          path: destPath,
          mimeType: input.payload.mimeType,
        }
      }
    }
    await input.runtime.fs.writeFile(destPath, input.payload.buffer)
    return {
      path: destPath,
      mimeType: input.payload.mimeType,
    }
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    process.stderr.write(`feishu media: writeFile failed path=${destPath}: ${text}\n`)
    return null
  }
}

export function fileNameFor(messageId: string, key: ParsedMediaKey): string {
  const ext = inferExt(key)
  const rawName = key.fileName?.trim()
  if (rawName) {
    // Even when the upstream provided a file name, include the
    // per-mediaKey suffix so multi-attachment post messages whose
    // attachments happen to share the same display name don't
    // collide on disk.
    return sanitize(`${shortKeyHash(key.key)}-${rawName}`)
  }
  // Multi-attachment Feishu `post` messages share `messageId` across
  // every img / file / media tag, so keying the inbox filename on
  // (messageId, kind) alone causes every attachment to write to the
  // same path — earlier downloads silently overwrite later ones, and
  // the encoder then reads the same bytes N times, producing the
  // "duplicated images" bug. Include a short hash of the unique
  // mediaKey (image_key / file_key) so each attachment lands at a
  // distinct path. Hash kept short so filenames stay readable; SHA-1
  // first-8-hex collision space (16^8 = 4.3B) is plenty for the
  // per-message attachment count cap.
  return sanitize(`${messageId}-${key.kind}-${shortKeyHash(key.key)}${ext}`)
}

function shortKeyHash(rawKey: string): string {
  return createHash('sha1').update(rawKey).digest('hex').slice(0, 8)
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

/** Lark SDK binary endpoints (im.messageResource.get and friends) return a
 *  wrapper object `{ writeFile(path), getReadableStream(), headers }`
 *  instead of the raw stream/buffer — see node_modules/@larksuiteoapi
 *  /node-sdk/lib/index.js (≈18 binary endpoints all use this shape).
 *  Unwrap to the readable stream so bufferizePayload's existing branches
 *  handle it. Older SDK versions / JSON envelopes that hand us a Buffer
 *  / Uint8Array / Stream directly bypass this unwrap. Without it,
 *  bufferizePayload's five branches all miss the wrapper and throw
 *  "unsupported payload type", which surfaces as `[media download failed]`
 *  to the user. */
export function unwrapResourceResponse(payload: unknown): unknown {
  if (
    payload &&
    typeof payload === 'object' &&
    typeof (payload as { getReadableStream?: unknown }).getReadableStream === 'function'
  ) {
    return (payload as { getReadableStream: () => unknown }).getReadableStream()
  }
  return payload
}

async function bufferizePayload(payload: unknown): Promise<Buffer> {
  if (Buffer.isBuffer(payload)) {
    return payload
  }
  if (payload instanceof Uint8Array) {
    return Buffer.from(payload)
  }
  if (payload instanceof ArrayBuffer) {
    return Buffer.from(payload)
  }
  if (payload instanceof Readable) {
    return streamToBuffer(payload)
  }
  if (payload && typeof (payload as { pipe?: unknown }).pipe === 'function') {
    return streamToBuffer(payload as NodeJS.ReadableStream)
  }
  throw new Error('unsupported payload type from Feishu messageResource.get')
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

function sanitize(input: string): string {
  const value = input.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 120)
  return value || 'media'
}
