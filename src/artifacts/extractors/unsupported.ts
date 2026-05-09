import type { ArtifactExtractionInput, ArtifactExtractionResult, ArtifactExtractor } from './types.js'

export function createUnsupportedExtractor(
  format: ArtifactExtractor['format'],
  label = format,
): ArtifactExtractor {
  return {
    format,
    extract(_input: ArtifactExtractionInput): ArtifactExtractionResult {
      return {
        format,
        text: '',
        truncated: false,
        warnings: [
          `${label} extraction is not available in this runtime yet. Use Bash with an installed parser, or convert the file to text/CSV first.`,
        ],
      }
    },
  }
}

