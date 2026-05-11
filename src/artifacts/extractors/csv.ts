import { stripUtf8Bom, truncate } from './common.js'
import type { ArtifactExtractionInput, ArtifactExtractionResult, ArtifactExtractor } from './types.js'

export const csvExtractor: ArtifactExtractor = {
  format: 'csv',
  extract(input: ArtifactExtractionInput): ArtifactExtractionResult {
    const text = stripUtf8Bom(input.buffer.toString('utf8'))
    const { value, truncated } = truncate(text, input.maxChars)
    return {
      format: inferDelimitedFormat(input.filePath),
      text: value,
      truncated,
      warnings: [],
    }
  },
}

function inferDelimitedFormat(filePath: string): 'csv' | 'tsv' {
  return filePath.toLowerCase().endsWith('.tsv') ? 'tsv' : 'csv'
}

