import { stripUtf8Bom, truncate } from './common.js'
import type { ArtifactExtractionInput, ArtifactExtractionResult, ArtifactExtractor } from './types.js'

export const textExtractor: ArtifactExtractor = {
  format: 'text',
  extract(input: ArtifactExtractionInput): ArtifactExtractionResult {
    const encoding = input.encoding ?? 'utf8'
    const text = stripUtf8Bom(input.buffer.toString(encoding as BufferEncoding))
    const { value, truncated } = truncate(text, input.maxChars)
    return {
      format: inferTextLikeFormat(input.filePath),
      text: value,
      truncated,
      warnings: [],
    }
  },
}

function inferTextLikeFormat(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase()
  return ext && ext !== filePath.toLowerCase() ? ext : 'text'
}

