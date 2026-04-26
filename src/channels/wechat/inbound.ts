import fs from 'node:fs/promises'
import path from 'node:path'

import type { NormalizedChannelMessage } from '../types.js'
import { fetchAndDecryptMedia } from './cdn/media-download.js'
import {
  MessageItemType,
  type CDNMedia,
  type MessageItem,
  type WechatMessage,
} from './api/types.js'

export async function wechatMessageToInbound(input: {
  msg: WechatMessage
  accountId: string
  cdnBaseUrl: string
  mediaDir: string
  mediaEnabled: boolean
}): Promise<NormalizedChannelMessage> {
  const senderId = input.msg.from_user_id ?? ''
  const messageId = String(input.msg.message_id ?? input.msg.client_id ?? Date.now())
  const message: NormalizedChannelMessage = {
    channel: 'wechat',
    eventId: `wechat-${messageId}`,
    chatId: senderId,
    senderOpenId: senderId,
    senderKey: `wechat:${senderId}`,
    chatType: 'p2p',
    messageId,
    text: bodyFromItemList(input.msg.item_list),
  }

  if (!input.mediaEnabled) {
    if (pickMediaItem(input.msg.item_list)) {
      message.text = appendLine(message.text, '[媒体附件: skipped (mediaEnabled=false)]')
    }
    return message
  }

  const mediaItem = pickMediaItem(input.msg.item_list)
  if (!mediaItem) {
    return message
  }

  try {
    const downloaded = await downloadInboundMedia({
      msg: input.msg,
      mediaItem,
      cdnBaseUrl: input.cdnBaseUrl,
      mediaDir: input.mediaDir,
    })
    if (downloaded) {
      message.mediaPath = downloaded.path
      message.mediaType = downloaded.mimeType
    }
  } catch (error) {
    process.stderr.write(`wechat media: ${String(error)}\n`)
    message.text = appendLine(message.text, '[媒体下载失败]')
  }
  return message
}

function bodyFromItemList(itemList?: MessageItem[]): string {
  if (!itemList?.length) {
    return ''
  }
  for (const item of itemList) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
      const text = String(item.text_item.text)
      const ref = item.ref_msg
      if (!ref) {
        return text
      }
      if (ref.message_item && isMediaItem(ref.message_item)) {
        return text
      }
      const parts: string[] = []
      if (ref.title) {
        parts.push(ref.title)
      }
      if (ref.message_item) {
        const refBody = bodyFromItemList([ref.message_item])
        if (refBody) {
          parts.push(refBody)
        }
      }
      return parts.length ? `[引用: ${parts.join(' | ')}]\n${text}` : text
    }
    if (item.type === MessageItemType.VOICE) {
      return item.voice_item?.text || '[语音消息: 无转录]'
    }
  }
  return ''
}

function pickMediaItem(itemList?: MessageItem[]): MessageItem | null {
  if (!itemList?.length) {
    return null
  }
  return (
    itemList.find(item => item.type === MessageItemType.IMAGE) ??
    itemList.find(item => item.type === MessageItemType.VIDEO) ??
    itemList.find(item => item.type === MessageItemType.FILE) ??
    null
  )
}

async function downloadInboundMedia(input: {
  msg: WechatMessage
  mediaItem: MessageItem
  cdnBaseUrl: string
  mediaDir: string
}): Promise<{ path: string; mimeType: string } | null> {
  const details = mediaDetails(input.mediaItem)
  if (!details) {
    return null
  }
  const senderId = input.msg.from_user_id ?? 'unknown'
  const messageId = String(input.msg.message_id ?? input.msg.client_id ?? Date.now())
  const destDir = path.join(input.mediaDir, sanitize(senderId))
  await fs.mkdir(destDir, { recursive: true })
  const destPath = path.join(destDir, sanitize(`${messageId}-${details.fileName}`))
  const buffer = await fetchAndDecryptMedia({
    cdnBaseUrl: input.cdnBaseUrl,
    encryptQueryParam: details.media.encrypt_query_param ?? '',
    aesKey: details.aesKey,
    aesKeyEncoding: details.aesKeyEncoding,
    fullUrl: details.media.full_url,
  })
  await fs.writeFile(destPath, buffer)
  return {
    path: destPath,
    mimeType: details.mimeType,
  }
}

function mediaDetails(item: MessageItem): {
  media: CDNMedia
  aesKey: string
  aesKeyEncoding: 'base64' | 'hex'
  fileName: string
  mimeType: string
} | null {
  if (item.type === MessageItemType.IMAGE) {
    const media = item.image_item?.media
    const aesKey = item.image_item?.aeskey ?? media?.aes_key
    const aesKeyEncoding = item.image_item?.aeskey ? 'hex' : 'base64'
    return media && aesKey
      ? { media, aesKey, aesKeyEncoding, fileName: 'image.jpg', mimeType: 'image/jpeg' }
      : null
  }
  if (item.type === MessageItemType.VIDEO) {
    const media = item.video_item?.media
    const aesKey = media?.aes_key
    return media && aesKey
      ? { media, aesKey, aesKeyEncoding: 'base64', fileName: 'video.mp4', mimeType: 'video/mp4' }
      : null
  }
  if (item.type === MessageItemType.FILE) {
    const media = item.file_item?.media
    const aesKey = media?.aes_key
    const fileName = item.file_item?.file_name?.trim() || 'file.bin'
    return media && aesKey
      ? {
          media,
          aesKey,
          aesKeyEncoding: 'base64',
          fileName,
          mimeType: mimeFromFileName(fileName),
        }
      : null
  }
  return null
}

function isMediaItem(item: MessageItem): boolean {
  return (
    item.type === MessageItemType.IMAGE ||
    item.type === MessageItemType.VIDEO ||
    item.type === MessageItemType.FILE ||
    item.type === MessageItemType.VOICE
  )
}

function appendLine(text: string, line: string): string {
  return text ? `${text}\n${line}` : line
}

function sanitize(input: string): string {
  const sanitized = input.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 120)
  return sanitized || 'media'
}

function mimeFromFileName(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase()
  if (ext === '.pdf') return 'application/pdf'
  if (ext === '.txt') return 'text/plain'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.png') return 'image/png'
  if (ext === '.mp4') return 'video/mp4'
  if (ext === '.doc') return 'application/msword'
  if (ext === '.docx') {
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  }
  return 'application/octet-stream'
}
