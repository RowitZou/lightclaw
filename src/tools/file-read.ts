import path from 'node:path'

import { z } from 'zod'

import {
  extractArtifactText,
  inferArtifactFormat,
} from '../artifacts/extractors/registry.js'
import { suggestPathRules } from '../permission/suggestions.js'
import { buildTool } from '../tool.js'

const DEFAULT_MAX_CHARS = 20_000
const MAX_MAX_CHARS = 100_000
const MAX_OFFICE_BYTES = 20 * 1024 * 1024

const PDF_REJECT_MESSAGE =
  'Read does not extract PDF text because plain text extraction can lose layout, tables, figures, formulas, and scanned content. Use RenderPdfPages to inspect selected PDF pages visually.'

const inputSchema = z.object({
  file_path: z.string().min(1),
  offset: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).optional(),
  sheet: z.string().min(1).optional(),
  range: z.string().min(1).optional(),
  max_rows: z.number().int().min(1).max(1000).optional(),
  max_cols: z.number().int().min(1).max(200).optional(),
  max_chars: z.number().int().min(1).max(MAX_MAX_CHARS).optional(),
  encoding: z.string().min(1).optional(),
})

export type FileReadStructuredOutput = {
  filePath: string
  format: string
  text: string
  truncated: boolean
  sizeBytes: number
  warnings: string[]
  metadata?: Record<string, unknown>
}

function resolveInputPath(cwd: string, inputPath: string): string {
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(cwd, inputPath)
}

function formatLines(content: string, offset: number, limit?: number): string {
  const lines = content.split(/\r?\n/)
  const start = Math.max(1, offset)
  const end = limit ? start - 1 + limit : lines.length
  const selected = lines.slice(start - 1, end)

  if (selected.length === 0) {
    return '[no lines selected]'
  }

  return selected
    .map((line, index) => `${String(start + index).padStart(6, ' ')} | ${line}`)
    .join('\n')
}

export const fileReadTool = buildTool<
  z.infer<typeof inputSchema>,
  FileReadStructuredOutput | string
>({
  name: 'Read',
  description:
    'Read a file as text. Plain text / code / log / json / csv returns line-numbered output sliceable with offset and limit. ' +
    'Office documents (.xlsx, .docx) are auto-extracted via sandbox parser; xlsx accepts sheet / range / max_rows / max_cols. ' +
    'PDF files are not supported here — use RenderPdfPages instead. ' +
    'Channel attachments live under .lightclaw/inbox/<chatId>/<file>.',
  domain: 'environment',
  riskLevel: 'safe',
  concurrencySafe: true,
  inputSchema,
  suggestPermissionRules(input) {
    return suggestPathRules('Read', input.file_path)
  },
  async call(input, context) {
    try {
      const filePath = resolveInputPath(context.runtime.workspaceRoot, input.file_path)
      const probableFormat = inferArtifactFormat(filePath, undefined)

      if (probableFormat === 'pdf') {
        return { output: PDF_REJECT_MESSAGE, isError: true }
      }

      if (probableFormat === 'xlsx' || probableFormat === 'docx') {
        const stat = await context.runtime.fs.stat(filePath)
        if (!stat.isFile) {
          return {
            output: `Read expected a regular file: ${filePath}`,
            isError: true,
          }
        }
        if (stat.size > MAX_OFFICE_BYTES) {
          return {
            output:
              `Read refused to extract ${stat.size} bytes from ${filePath}; office-doc limit is ${MAX_OFFICE_BYTES} bytes.`,
            isError: true,
          }
        }
        const buffer = await context.runtime.fs.readFile(filePath)
        const extraction = await extractArtifactText({
          buffer,
          filePath,
          encoding: input.encoding,
          maxChars: input.max_chars ?? DEFAULT_MAX_CHARS,
          sheet: input.sheet,
          range: input.range,
          maxRows: input.max_rows,
          maxCols: input.max_cols,
          exec: params => context.runtime.exec(params),
        })
        return {
          output: {
            filePath,
            format: extraction.format,
            text: extraction.text,
            truncated: extraction.truncated,
            sizeBytes: buffer.length,
            warnings: extraction.warnings,
            metadata: extraction.metadata,
          },
        }
      }

      const content = (await context.runtime.fs.readFile(filePath)).toString('utf8')
      return {
        output: formatLines(content, input.offset ?? 1, input.limit),
      }
    } catch (error) {
      return {
        output: error instanceof Error ? error.message : String(error),
        isError: true,
      }
    }
  },
})
