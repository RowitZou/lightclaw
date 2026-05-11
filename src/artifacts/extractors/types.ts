export type ArtifactExtractionFormat =
  | 'text'
  | 'json'
  | 'csv'
  | 'pdf'
  | 'xlsx'
  | 'docx'
  | 'pptx'
  | 'notebook'
  | 'binary'

/** xlsx-specific options. Packed into a sub-object because they only apply
 *  when the file is a spreadsheet — keeping them at the top level of the
 *  tool schema confused agents into passing `max_rows` on PDF reads
 *  (Bug C in 2026-05-10 audit). */
export type XlsxExtractionOptions = {
  sheet?: string
  range?: string
  maxRows?: number
  maxCols?: number
}

export type ArtifactExtractionInput = {
  buffer: Buffer
  filePath: string
  mimeType?: string
  maxChars: number
  /** xlsx-only options (sheet / range / maxRows / maxCols). Ignored by
   *  other formats. The Read tool input has the same shape. */
  xlsx?: XlsxExtractionOptions
  /** PDF-only: restrict text extraction to a closed inclusive page range.
   *  When set, the PDF extractor passes `-f firstPage -l lastPage` to
   *  pdftotext so only those pages' text comes back. Lets the agent
   *  navigate long PDFs (e.g. a 40-page paper) one section at a time
   *  without paying for the full document inside `max_chars`. Ignored by
   *  non-PDF formats. */
  pdfPageRange?: { firstPage: number; lastPage: number }
  exec?: ArtifactExtractionExec
}

export type ArtifactExtractionResult = {
  format: ArtifactExtractionFormat | string
  text: string
  truncated: boolean
  warnings: string[]
  metadata?: Record<string, unknown>
}

export type ArtifactExtractor = {
  readonly format: ArtifactExtractionFormat
  extract(input: ArtifactExtractionInput): Promise<ArtifactExtractionResult> | ArtifactExtractionResult
}

export type ArtifactExtractionExec = (input: {
  command: string
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
  maxBufferBytes?: number
  stdin?: string | Buffer
}) => Promise<{
  stdout: string
  stderr: string
  exitCode: number
}>
