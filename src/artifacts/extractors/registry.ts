import path from 'node:path'

import { csvExtractor } from './csv.js'
import { docxExtractor } from './docx.js'
import { jsonExtractor } from './json.js'
import { notebookExtractor } from './notebook.js'
import { pdfExtractor } from './pdf.js'
import { pptxExtractor } from './pptx.js'
import { textExtractor } from './text.js'
import type {
  ArtifactExtractionFormat,
  ArtifactExtractionInput,
  ArtifactExtractionResult,
  ArtifactExtractor,
} from './types.js'
import { createUnsupportedExtractor } from './unsupported.js'
import { xlsxExtractor } from './xlsx.js'

const extractorByFormat = new Map<ArtifactExtractionFormat, ArtifactExtractor>([
  ['text', textExtractor],
  ['json', jsonExtractor],
  ['csv', csvExtractor],
  ['pdf', pdfExtractor],
  ['xlsx', xlsxExtractor],
  ['docx', docxExtractor],
  ['pptx', pptxExtractor],
  ['notebook', notebookExtractor],
  ['binary', createUnsupportedExtractor('binary')],
])

export async function extractArtifactText(
  input: ArtifactExtractionInput,
): Promise<ArtifactExtractionResult> {
  const format = inferArtifactFormat(input.filePath, input.mimeType)
  const extractor = extractorByFormat.get(format) ?? textExtractor
  return await extractor.extract(input)
}

export function inferArtifactFormat(
  filePath: string,
  mimeType: string | undefined,
): ArtifactExtractionFormat {
  const mime = mimeType?.toLowerCase() ?? ''
  const ext = path.extname(filePath).toLowerCase()
  if (mime === 'application/pdf' || ext === '.pdf') return 'pdf'
  if (
    mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    ext === '.xlsx' ||
    ext === '.xls'
  ) {
    return 'xlsx'
  }
  if (
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    ext === '.docx' ||
    ext === '.doc'
  ) {
    return 'docx'
  }
  if (
    mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
    ext === '.pptx' ||
    ext === '.ppt'
  ) {
    return 'pptx'
  }
  if (ext === '.ipynb') return 'notebook'
  if (mime.includes('json') || ext === '.json') return 'json'
  if (mime.includes('csv') || ext === '.csv' || ext === '.tsv') return 'csv'
  if (mime.startsWith('text/') || isTextExtension(ext)) return 'text'
  if (looksBinaryExtension(ext)) return 'binary'
  return 'text'
}

function isTextExtension(ext: string): boolean {
  return [
    '.txt',
    '.md',
    '.markdown',
    '.log',
    '.csv',
    '.tsv',
    '.json',
    '.jsonl',
    '.yaml',
    '.yml',
    '.xml',
    '.html',
    '.css',
    '.js',
    '.ts',
    '.py',
    '.java',
    '.go',
    '.rs',
    '.sh',
    '.sql',
  ].includes(ext)
}

function looksBinaryExtension(ext: string): boolean {
  return [
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.webp',
    '.zip',
    '.gz',
    '.tar',
    '.mp4',
    '.mov',
    '.mp3',
    '.wav',
  ].includes(ext)
}
