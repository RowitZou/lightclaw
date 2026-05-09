export type ArtifactExtractionFormat =
  | 'text'
  | 'json'
  | 'csv'
  | 'pdf'
  | 'xlsx'
  | 'docx'
  | 'binary'

export type ArtifactExtractionInput = {
  buffer: Buffer
  filePath: string
  mimeType?: string
  encoding?: string
  maxChars: number
  sheet?: string
  range?: string
  maxRows?: number
  maxCols?: number
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
