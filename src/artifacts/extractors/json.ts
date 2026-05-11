import { stripUtf8Bom, truncate } from './common.js'
import type { ArtifactExtractionInput, ArtifactExtractionResult, ArtifactExtractor } from './types.js'

export const jsonExtractor: ArtifactExtractor = {
  format: 'json',
  extract(input: ArtifactExtractionInput): ArtifactExtractionResult {
    let text = stripUtf8Bom(input.buffer.toString('utf8'))
    const warnings: string[] = []
    try {
      text = JSON.stringify(JSON.parse(text), null, 2)
    } catch {
      warnings.push('File extension/MIME suggests JSON, but parsing failed; returning raw text.')
    }
    const { value, truncated } = truncate(text, input.maxChars)
    return {
      format: 'json',
      text: value,
      truncated,
      warnings,
    }
  },
}

