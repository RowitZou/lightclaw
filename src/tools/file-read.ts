import path from 'node:path'

import { z } from 'zod'

import {
  extractArtifactText,
  inferArtifactFormat,
} from '../artifacts/extractors/registry.js'
import { inspectImageBuffer } from '../artifacts/media/image.js'
import { resizeImageForVision } from '../artifacts/media/resize.js'
import {
  MAX_IMAGE_BYTES,
  MAX_PAGES_PER_READ,
  MAX_PDF_BYTES,
  MAX_RESIZE_TARGET_MB,
  assertPdfHeader,
  buildPdfPageOutputDir,
  cleanupPdfPageDir,
  comparePdfPageImageNames,
  getPdfPageCount,
  isVisualImageExtension,
  pageNumberFromImageName,
  renderPdfPages,
  resolvePageRange,
  resolveResizeTarget,
} from '../artifacts/visual-rendering.js'
import { suggestPathRules } from '../permission/suggestions.js'
import { buildTool, type ToolCallContext } from '../tool.js'
import type { ToolResultContentBlock, UserToolResultBlock } from '../types.js'

const DEFAULT_MAX_CHARS = 20_000
const MAX_MAX_CHARS = 100_000
const MAX_OFFICE_BYTES = 20 * 1024 * 1024

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
  /** PDF only: page selector (e.g. "1", "1-5", "10-12"). Triggers visual
   *  rendering — pages are rasterized via pdftoppm and emitted as inline
   *  image blocks for the main model (or sub-LLM-described text on
   *  non-vision endpoints). When omitted, PDFs default to the cheaper
   *  pdftotext text path; specify `pages` whenever the agent needs
   *  figures, formulas, layout, or scanned-page fidelity. Max
   *  MAX_PAGES_PER_READ pages per call. */
  pages: z.string().min(1).optional(),
  /** Image / PDF visual path: override the per-image resize target in
   *  megabytes. Defaults to `attachments.imageMaxMb` from config; raise
   *  for fine OCR / dense diagrams when the default fidelity is too
   *  coarse. Capped at MAX_RESIZE_TARGET_MB. */
  resize_target_mb: z.number().min(0.5).max(MAX_RESIZE_TARGET_MB).optional(),
})

type FileReadInput = z.infer<typeof inputSchema>

export type FileReadStructuredOutput = {
  filePath: string
  format: string
  text: string
  truncated: boolean
  sizeBytes: number
  warnings: string[]
  metadata?: Record<string, unknown>
}

/** Marker carried by Read calls that produce inline image blocks (image
 *  files, PDF + pages). Detected by formatResult and lifted into
 *  `tool_result.content` array directly. The text-only paths continue
 *  to return the structured / string shapes used by existing callers. */
export type FileReadVisualOutput = {
  kind: 'visual'
  format: 'image' | 'pdf'
  toolResultContent: ToolResultContentBlock[]
}

export type FileReadOutput = FileReadStructuredOutput | string | FileReadVisualOutput

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

export const fileReadTool = buildTool<FileReadInput, FileReadOutput>({
  name: 'Read',
  description:
    'Read a file. Plain text / code / log / json / csv returns line-numbered output sliceable with offset and limit. '
    + 'Office documents (.xlsx, .docx, .pptx) auto-extract via sandbox parser (openpyxl / python-docx / python-pptx); xlsx accepts sheet / range / max_rows / max_cols. '
    + 'PDF returns extracted text via pdftotext layout mode by default. To inspect figures / formulas / scanned pages, pass `pages` (e.g. "1", "1-5", max 20) — that path renders pages with pdftoppm and emits inline image blocks for vision-capable models, or sub-LLM-described text otherwise. '
    + 'Image files (.jpg/.png/.gif/.webp) return inline image blocks so the model sees pixels directly; on non-vision endpoints they degrade to a sub-LLM description. '
    + 'resize_target_mb (optional, default = attachments.imageMaxMb config, max 16): raise when the default fidelity is too coarse and the model needs more detail. '
    + 'Channel attachments live under .lightclaw/inbox/<chatId>/<file>; web downloads under .lightclaw/downloads/<file>.',
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

      // Image files: visual path. Always emit image block (finalization
      // handles non-vision endpoints by replacing with describe-text).
      if (isVisualImageExtension(filePath)) {
        return await readImageVisual(input, filePath, context)
      }

      // PDF + pages: visual path. Without `pages` we keep pdftotext.
      if (probableFormat === 'pdf' && input.pages !== undefined) {
        return await readPdfVisual(input, filePath, context)
      }

      if (
        probableFormat === 'pdf'
        || probableFormat === 'xlsx'
        || probableFormat === 'docx'
        || probableFormat === 'pptx'
      ) {
        const stat = await context.runtime.fs.stat(filePath)
        if (!stat.isFile) {
          return {
            output: `Read expected a regular file: ${filePath}`,
            isError: true,
          }
        }
        const sizeCap = probableFormat === 'pdf' ? MAX_PDF_BYTES : MAX_OFFICE_BYTES
        if (stat.size > sizeCap) {
          return {
            output:
              `Read refused to extract ${stat.size} bytes from ${filePath}; ${probableFormat} limit is ${sizeCap} bytes.`,
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
  formatResult(output, toolUseId, isError): UserToolResultBlock {
    if (typeof output === 'object' && output !== null && 'kind' in output && output.kind === 'visual') {
      return {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: output.toolResultContent,
        ...(isError ? { is_error: true } : {}),
      }
    }
    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: typeof output === 'string' ? output : JSON.stringify(output, null, 2),
      ...(isError ? { is_error: true } : {}),
    }
  },
})

async function readImageVisual(
  input: FileReadInput,
  filePath: string,
  context: ToolCallContext,
): Promise<{ output: FileReadOutput; isError?: boolean }> {
  const stat = await context.runtime.fs.stat(filePath)
  if (!stat.isFile) {
    return { output: `Read expected a regular file: ${filePath}`, isError: true }
  }
  if (stat.size > MAX_IMAGE_BYTES) {
    return {
      output: `Read refused to read ${stat.size} bytes from ${filePath}; image limit is ${MAX_IMAGE_BYTES} bytes.`,
      isError: true,
    }
  }

  const resized = await resizeImageForVision({
    filePath,
    fs: context.runtime.fs,
    workspaceRoot: context.runtime.workspaceRoot,
    exec: params => context.runtime.exec(params),
    targetBytes: resolveResizeTarget(input.resize_target_mb),
  })
  const inspected = inspectImageBuffer(resized.buffer, {
    mimeType: resized.mimeType,
    maxBytes: MAX_IMAGE_BYTES,
  })
  if (!inspected.ok) {
    return { output: inspected.reason, isError: true }
  }

  const warnings = [...resized.warnings, ...inspected.metadata.warnings]
  const headerLines = [
    `[Image: ${path.basename(filePath)}]`,
    `path: ${filePath}`,
    `mime: ${inspected.metadata.mimeType}`,
    ...(inspected.metadata.width && inspected.metadata.height
      ? [`dimensions: ${inspected.metadata.width}x${inspected.metadata.height}`]
      : []),
    `size: ${inspected.metadata.sizeBytes} bytes (after resize)`,
    ...(warnings.length > 0 ? warnings.map(w => `note: ${w}`) : []),
  ].join('\n')

  return {
    output: {
      kind: 'visual',
      format: 'image',
      toolResultContent: [
        { type: 'text', text: headerLines },
        {
          type: 'image',
          source: {
            type: 'base64',
            mediaType: inspected.metadata.mimeType,
            data: resized.buffer.toString('base64'),
          },
        },
      ],
    },
  }
}

async function readPdfVisual(
  input: FileReadInput,
  filePath: string,
  context: ToolCallContext,
): Promise<{ output: FileReadOutput; isError?: boolean }> {
  let outputDirToCleanup: string | undefined
  try {
    const stat = await context.runtime.fs.stat(filePath)
    if (!stat.isFile) {
      return { output: `Read expected a regular file: ${filePath}`, isError: true }
    }
    if (stat.size === 0) {
      return { output: `PDF file is empty: ${filePath}`, isError: true }
    }
    if (stat.size > MAX_PDF_BYTES) {
      return {
        output: `Read refused to read ${stat.size} bytes from ${filePath}; PDF limit is ${MAX_PDF_BYTES} bytes.`,
        isError: true,
      }
    }

    await assertPdfHeader(context, filePath)
    const pageCount = await getPdfPageCount(context, filePath)
    const range = resolvePageRange(input.pages, pageCount)
    const outputDir = buildPdfPageOutputDir(context.runtime.workspaceRoot)
    outputDirToCleanup = outputDir
    await renderPdfPages(context, {
      filePath,
      outputDir,
      firstPage: range.firstPage,
      lastPage: range.lastPage,
    })

    const imageFiles = (await context.runtime.fs.readdir(outputDir))
      .filter(file => file.toLowerCase().endsWith('.jpg') || file.toLowerCase().endsWith('.jpeg'))
      .sort(comparePdfPageImageNames)
    if (imageFiles.length === 0) {
      return {
        output:
          'pdftoppm produced no page images. The PDF may be invalid or the page range may be empty.',
        isError: true,
      }
    }

    const blocks: ToolResultContentBlock[] = []
    const warnings: string[] = [...range.warnings]

    for (const [index, imageFile] of imageFiles.entries()) {
      const imagePath = path.posix.join(outputDir, imageFile)
      const page = pageNumberFromImageName(imageFile) ?? range.firstPage + index
      const resized = await resizeImageForVision({
        filePath: imagePath,
        fs: context.runtime.fs,
        workspaceRoot: context.runtime.workspaceRoot,
        exec: params => context.runtime.exec(params),
        targetBytes: resolveResizeTarget(input.resize_target_mb),
      })
      if (resized.warnings.length > 0) {
        warnings.push(`page ${page}: ${resized.warnings.join('; ')}`)
      }
      const inspected = inspectImageBuffer(resized.buffer, { mimeType: resized.mimeType })
      if (!inspected.ok) {
        warnings.push(`page ${page}: ${inspected.reason}`)
        continue
      }
      blocks.push({
        type: 'text',
        text: `[Page ${page} of ${path.basename(filePath)}, ${inspected.metadata.width ?? '?'}x${inspected.metadata.height ?? '?'}, ${inspected.metadata.sizeBytes} bytes]`,
      })
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          mediaType: inspected.metadata.mimeType,
          data: resized.buffer.toString('base64'),
        },
      })
    }
    if (blocks.length === 0) {
      return {
        output: 'No valid PDF page images were rendered for vision inspection.',
        isError: true,
      }
    }

    // Lead the content with a one-line file header so the model has the
    // file path / page range context up-front before pages stream in.
    const header: ToolResultContentBlock = {
      type: 'text',
      text: [
        `[PDF: ${path.basename(filePath)}]`,
        `path: ${filePath}`,
        `pages: ${range.firstPage}-${range.lastPage}${pageCount ? ` of ${pageCount}` : ''}`,
        ...(warnings.length > 0 ? warnings.map(w => `note: ${w}`) : []),
      ].join('\n'),
    }

    return {
      output: {
        kind: 'visual',
        format: 'pdf',
        toolResultContent: [header, ...blocks],
      },
    }
  } catch (error) {
    return {
      output: error instanceof Error ? error.message : String(error),
      isError: true,
    }
  } finally {
    if (outputDirToCleanup) {
      await cleanupPdfPageDir(context, outputDirToCleanup).catch(() => undefined)
    }
  }
}
