import { truncate } from './common.js'
import type { ArtifactExtractionInput, ArtifactExtractionResult, ArtifactExtractor } from './types.js'

const PDF_HEADER = '%PDF-'

/** Sandbox `pdftotext -layout` extracts the textual layer of a PDF preserving
 *  approximate column / table structure. Reading-order quirks are accepted as
 *  cost — `-raw` is available as a future option if a use case demands it.
 *  AnalyzeVisuals (sandbox `pdftoppm` + vision model) handles the visual
 *  modality: figures, formulas, scanned-only PDFs, and complex layouts. The
 *  two paths are intentionally complementary, picked by the LLM per intent. */
export const pdfExtractor: ArtifactExtractor = {
  format: 'pdf',
  async extract(input: ArtifactExtractionInput): Promise<ArtifactExtractionResult> {
    if (input.buffer.length === 0) {
      return pdfWarning('PDF file is empty.')
    }
    if (!input.buffer.subarray(0, PDF_HEADER.length).toString('ascii').startsWith(PDF_HEADER)) {
      return pdfWarning('File is not a valid PDF (missing %PDF- header).')
    }
    if (!input.exec) {
      return pdfWarning('PDF extraction requires a runtime command executor.')
    }

    const result = await input.exec({
      command:
        'command -v pdftotext >/dev/null 2>&1 || exit 127; ' +
        'pdftotext -layout -enc UTF-8 "$LIGHTCLAW_PDF_PATH" -',
      env: { LIGHTCLAW_PDF_PATH: input.filePath },
      timeoutMs: 60_000,
      maxBufferBytes: Math.max(input.maxChars * 4, 1024 * 1024),
    })
    if (result.exitCode === 127) {
      return pdfWarning(
        'pdftotext is not installed in this runtime. Install poppler-utils or use AnalyzeVisuals to inspect pages visually.',
      )
    }
    if (result.exitCode !== 0) {
      const stderr = result.stderr.trim()
      if (/password/i.test(stderr)) {
        return pdfWarning('PDF is password-protected. Provide an unprotected version.')
      }
      if (/damaged|corrupt|invalid/i.test(stderr)) {
        return pdfWarning('PDF file is corrupted or invalid.')
      }
      return pdfWarning(stderr || 'pdftotext failed.')
    }

    const { value, truncated } = truncate(result.stdout, input.maxChars)
    return {
      format: 'pdf',
      text: value,
      truncated,
      warnings: value.trim() ? [] : [
        'pdftotext returned no text. The PDF may be scanned (image-only); use AnalyzeVisuals to inspect pages visually.',
      ],
      metadata: {
        extractor: 'pdftotext',
        layout: 'layout',
      },
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
