import type { ArtifactExtractionInput, ArtifactExtractionResult, ArtifactExtractor } from './types.js'

const PDF_HEADER = '%PDF-'

export const pdfExtractor: ArtifactExtractor = {
  format: 'pdf',
  async extract(input: ArtifactExtractionInput): Promise<ArtifactExtractionResult> {
    if (input.buffer.length === 0) {
      return pdfWarning('PDF file is empty.')
    }
    if (!input.buffer.subarray(0, PDF_HEADER.length).toString('ascii').startsWith(PDF_HEADER)) {
      return pdfWarning('File is not a valid PDF (missing %PDF- header).')
    }

    return {
      format: 'pdf',
      text: '',
      truncated: false,
      warnings: [
        'PDF text extraction is intentionally disabled because plain text extraction can lose layout, tables, figures, formulas, and scanned content. Use RenderPdfPages to render selected pages temporarily and inspect them visually.',
      ],
      metadata: { extractor: 'disabled', readableWith: ['RenderPdfPages'] },
    }
  },
}

function pdfWarning(reason: string): ArtifactExtractionResult {
  return {
    format: 'pdf',
    text: '',
    truncated: false,
    warnings: [reason],
  }
}
