import type { ImageMediaType, ImageValidationResult } from './types.js'

const MAX_IMAGE_BYTES = 20 * 1024 * 1024

export function inspectImageBuffer(
  buffer: Buffer,
  input: { mimeType?: string; maxBytes?: number } = {},
): ImageValidationResult {
  const maxBytes = input.maxBytes ?? MAX_IMAGE_BYTES
  if (buffer.length === 0) {
    return { ok: false, reason: 'Image file is empty.' }
  }
  if (buffer.length > maxBytes) {
    return {
      ok: false,
      reason: `Image file is ${buffer.length} bytes; limit is ${maxBytes} bytes.`,
    }
  }

  const detected = detectImage(buffer)
  if (!detected) {
    return { ok: false, reason: 'File is not a supported image (png/jpeg/gif/webp).' }
  }

  const warnings: string[] = []
  const hinted = normalizeImageMime(input.mimeType)
  if (hinted && hinted !== detected.mimeType) {
    warnings.push(`MIME hint ${hinted} does not match detected ${detected.mimeType}.`)
  }

  return {
    ok: true,
    metadata: {
      kind: 'image',
      mimeType: detected.mimeType,
      format: detected.format,
      sizeBytes: buffer.length,
      width: detected.width,
      height: detected.height,
      warnings,
    },
  }
}

function normalizeImageMime(mimeType: string | undefined): ImageMediaType | undefined {
  const normalized = mimeType?.toLowerCase()
  if (
    normalized === 'image/png' ||
    normalized === 'image/jpeg' ||
    normalized === 'image/gif' ||
    normalized === 'image/webp'
  ) {
    return normalized
  }
  if (normalized === 'image/jpg') {
    return 'image/jpeg'
  }
  return undefined
}

function detectImage(buffer: Buffer): {
  mimeType: ImageMediaType
  format: 'png' | 'jpeg' | 'gif' | 'webp'
  width?: number
  height?: number
} | null {
  if (isPng(buffer)) {
    return {
      mimeType: 'image/png',
      format: 'png',
      width: buffer.length >= 24 ? buffer.readUInt32BE(16) : undefined,
      height: buffer.length >= 24 ? buffer.readUInt32BE(20) : undefined,
    }
  }
  if (isGif(buffer)) {
    return {
      mimeType: 'image/gif',
      format: 'gif',
      width: buffer.length >= 10 ? buffer.readUInt16LE(6) : undefined,
      height: buffer.length >= 10 ? buffer.readUInt16LE(8) : undefined,
    }
  }
  if (isWebp(buffer)) {
    return detectWebp(buffer)
  }
  if (isJpeg(buffer)) {
    return {
      mimeType: 'image/jpeg',
      format: 'jpeg',
      ...readJpegDimensions(buffer),
    }
  }
  return null
}

function isPng(buffer: Buffer): boolean {
  return buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
}

function isGif(buffer: Buffer): boolean {
  return buffer.length >= 6 &&
    (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' ||
      buffer.subarray(0, 6).toString('ascii') === 'GIF89a')
}

function isWebp(buffer: Buffer): boolean {
  return buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
}

function isJpeg(buffer: Buffer): boolean {
  return buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
}

function readJpegDimensions(buffer: Buffer): { width?: number; height?: number } {
  let offset = 2
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = buffer[offset + 1]
    const length = buffer.readUInt16BE(offset + 2)
    if (length < 2) {
      return {}
    }
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      ![0xc4, 0xc8, 0xcc].includes(marker)
    ) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      }
    }
    offset += 2 + length
  }
  return {}
}

function detectWebp(buffer: Buffer): {
  mimeType: ImageMediaType
  format: 'webp'
  width?: number
  height?: number
} {
  const chunk = buffer.length >= 16 ? buffer.subarray(12, 16).toString('ascii') : ''
  if (chunk === 'VP8X' && buffer.length >= 30) {
    return {
      mimeType: 'image/webp',
      format: 'webp',
      width: 1 + readUInt24LE(buffer, 24),
      height: 1 + readUInt24LE(buffer, 27),
    }
  }
  if (chunk === 'VP8 ' && buffer.length >= 30) {
    return {
      mimeType: 'image/webp',
      format: 'webp',
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    }
  }
  return {
    mimeType: 'image/webp',
    format: 'webp',
  }
}

function readUInt24LE(buffer: Buffer, offset: number): number {
  return buffer[offset]! | (buffer[offset + 1]! << 8) | (buffer[offset + 2]! << 16)
}

