import path from 'node:path'

import { z } from 'zod'

import {
  extractArtifactText,
  inferArtifactFormat,
} from '../artifacts/extractors/registry.js'
import {
  lookupArtifact,
  resolveArtifactPath,
  touchArtifact,
  type ArtifactRecord,
} from '../artifacts/registry.js'
import { suggestPathRules } from '../permission/suggestions.js'
import { buildTool, type ToolCallContext } from '../tool.js'

const DEFAULT_MAX_CHARS = 20_000
const MAX_MAX_CHARS = 100_000
const MAX_OFFICE_BYTES = 20 * 1024 * 1024

const PDF_REJECT_MESSAGE =
  'Read does not extract PDF text because plain text extraction can lose layout, tables, figures, formulas, and scanned content. Use RenderPdfPages to inspect selected PDF pages visually.'

const inputSchema = z.object({
  file_path: z.string().min(1).optional(),
  artifact_id: z.string().min(1).optional(),
  offset: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).optional(),
  sheet: z.string().min(1).optional(),
  range: z.string().min(1).optional(),
  max_rows: z.number().int().min(1).max(1000).optional(),
  max_cols: z.number().int().min(1).max(200).optional(),
  max_chars: z.number().int().min(1).max(MAX_MAX_CHARS).optional(),
  encoding: z.string().min(1).optional(),
}).refine(input => Boolean(input.artifact_id) !== Boolean(input.file_path), {
  message: 'Provide exactly one of artifact_id or file_path.',
})

export type FileReadStructuredOutput = {
  artifactId?: string
  filePath: string
  title?: string
  mimeType?: string
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

async function resolveSource(
  input: z.infer<typeof inputSchema>,
  context: ToolCallContext,
): Promise<{ filePath: string; artifact?: ArtifactRecord }> {
  if (input.artifact_id) {
    const artifact = await lookupArtifact(
      context.runtime.fs,
      input.artifact_id,
      context.runtime.workspaceRoot,
    )
    if (!artifact) {
      throw new Error(`Artifact not found: ${input.artifact_id}`)
    }
    const filePath = artifact.textExtractPath ?? artifact.workspacePath
    if (!filePath) {
      throw new Error(`Artifact has no workspace-readable path: ${input.artifact_id}`)
    }
    return {
      filePath: resolveArtifactPath(context.runtime.workspaceRoot, filePath),
      artifact,
    }
  }
  if (!input.file_path) {
    throw new Error('Provide exactly one of artifact_id or file_path.')
  }
  return { filePath: resolveInputPath(context.runtime.workspaceRoot, input.file_path) }
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
    'Accept either file_path or artifact_id (for imported channel attachments).',
  domain: 'environment',
  riskLevel: 'safe',
  concurrencySafe: true,
  inputSchema,
  suggestPermissionRules(input) {
    if (input.file_path) {
      return suggestPathRules('Read', input.file_path)
    }
    return []
  },
  async call(input, context) {
    try {
      const resolved = await resolveSource(input, context)
      const probableFormat = inferArtifactFormat(
        resolved.filePath,
        resolved.artifact?.mimeType,
      )

      if (probableFormat === 'pdf') {
        return { output: PDF_REJECT_MESSAGE, isError: true }
      }

      if (probableFormat === 'xlsx' || probableFormat === 'docx') {
        const stat = await context.runtime.fs.stat(resolved.filePath)
        if (!stat.isFile) {
          return {
            output: `Read expected a regular file: ${resolved.filePath}`,
            isError: true,
          }
        }
        if (stat.size > MAX_OFFICE_BYTES) {
          return {
            output:
              `Read refused to extract ${stat.size} bytes from ${resolved.filePath}; office-doc limit is ${MAX_OFFICE_BYTES} bytes.`,
            isError: true,
          }
        }
        const buffer = await context.runtime.fs.readFile(resolved.filePath)
        const extraction = await extractArtifactText({
          buffer,
          filePath: resolved.filePath,
          mimeType: resolved.artifact?.mimeType,
          encoding: input.encoding,
          maxChars: input.max_chars ?? DEFAULT_MAX_CHARS,
          sheet: input.sheet,
          range: input.range,
          maxRows: input.max_rows,
          maxCols: input.max_cols,
          exec: params => context.runtime.exec(params),
        })
        if (resolved.artifact) {
          await touchArtifact(
            context.runtime.fs,
            resolved.artifact.artifactId,
            new Date().toISOString(),
            context.runtime.workspaceRoot,
          )
        }
        return {
          output: {
            artifactId: resolved.artifact?.artifactId,
            filePath: resolved.filePath,
            title: resolved.artifact?.title,
            mimeType: resolved.artifact?.mimeType,
            format: extraction.format,
            text: extraction.text,
            truncated: extraction.truncated,
            sizeBytes: buffer.length,
            warnings: extraction.warnings,
            metadata: extraction.metadata,
          },
        }
      }

      const content = (await context.runtime.fs.readFile(resolved.filePath)).toString('utf8')
      if (resolved.artifact) {
        await touchArtifact(
          context.runtime.fs,
          resolved.artifact.artifactId,
          new Date().toISOString(),
          context.runtime.workspaceRoot,
        )
      }
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
