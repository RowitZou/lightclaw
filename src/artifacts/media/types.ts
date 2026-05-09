export type MediaKind = 'image' | 'audio' | 'video' | 'document' | 'unknown'

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

export type ImageMetadata = {
  kind: 'image'
  mimeType: ImageMediaType
  format: 'png' | 'jpeg' | 'gif' | 'webp'
  sizeBytes: number
  width?: number
  height?: number
  warnings: string[]
}

export type ImageValidationResult =
  | { ok: true; metadata: ImageMetadata }
  | { ok: false; reason: string }
