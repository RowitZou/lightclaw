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

import { hasBeenRead, markRead } from './read-dedup.js'

const DEFAULT_MAX_CHARS = 50_000
const MAX_MAX_CHARS = 100_000
const MAX_OFFICE_BYTES = 20 * 1024 * 1024

/**
 * Extensions Read should reject up-front (not a text file, no special
 * handler). Anything not on this list AND not on the special-handler
 * whitelist (PDF/image/Office/.ipynb) falls into the generic plain-text
 * path. This mirrors Claude Code's `hasBinaryExtension` check.
 *
 * Bug C in 2026-05-10 audit motivated this: agents were Read'ing
 * `.zip` / `.so` / `.mp3` and getting garbage utf8. Now they bounce with
 * a tailored hint that points to the right tool.
 */
const BINARY_REJECT_EXTENSIONS = new Set([
  '.zip', '.tar', '.tgz', '.gz', '.bz2', '.xz', '.7z', '.rar',
  '.mp3', '.wav', '.flac', '.ogg', '.m4a',
  '.mp4', '.avi', '.mov', '.mkv', '.webm',
  '.so', '.o', '.a', '.dylib', '.dll', '.exe', '.bin',
  '.pyc', '.pyo', '.class', '.jar', '.wasm',
  '.iso', '.dmg', '.deb', '.rpm',
])

function binaryRejectHint(filePath: string, ext: string): string {
  if (['.mp3', '.wav', '.flac', '.ogg', '.m4a'].includes(ext)) {
    return (
      `Read cannot ingest audio files (${ext}). `
      + `Audio transcription requires a separate transcribe step (not yet wired into Read).`
    )
  }
  if (['.mp4', '.avi', '.mov', '.mkv', '.webm'].includes(ext)) {
    return (
      `Read cannot ingest video files (${ext}). `
      + `For specific frames, run ffmpeg via Bash to extract still images, then Read those.`
    )
  }
  if (['.zip', '.tar', '.tgz', '.gz', '.bz2', '.xz', '.7z', '.rar', '.iso', '.dmg', '.deb', '.rpm'].includes(ext)) {
    return (
      `Read cannot ingest archive files (${ext}). `
      + `Run Bash (unzip -l / tar -tf / 7z l) to inspect contents, then Read individual entries.`
    )
  }
  return (
    `Read cannot ingest binary file ${filePath} (extension "${ext}" is on the binary reject list). `
    + `Use Bash with an appropriate extractor (strings / objdump / etc) and Read the extracted text.`
  )
}

const inputSchema = z.object({
  file_path: z.string().min(1).describe('Absolute path to the file to read, or a path relative to the workspace root.'),
  offset: z.number().int().min(1).optional()
    .describe('Plain text / code only — line number to start reading from (1-indexed).'),
  limit: z.number().int().min(1).optional()
    .describe('Plain text / code only — number of lines to read.'),
  pages: z.string().min(1).optional()
    .describe(`PDF only — page selector "1" / "1-5" / "10-12" to trigger visual rendering. Max ${MAX_PAGES_PER_READ} pages per call. Without pages, PDFs use the cheaper pdftotext text path.`),
  xlsx: z.object({
    sheet: z.string().min(1).optional().describe('Sheet name (defaults to first sheet).'),
    range: z.string().min(1).optional().describe('A1:D20 style cell range.'),
    max_rows: z.number().int().min(1).max(1000).optional().describe('Cap on rows returned (default 50).'),
    max_cols: z.number().int().min(1).max(200).optional().describe('Cap on columns returned (default 20).'),
  }).optional().describe('xlsx-specific options. Ignored for non-spreadsheet files.'),
  max_chars: z.number().int().min(1).max(MAX_MAX_CHARS).optional()
    .describe(`Cap on extracted text characters for PDF / Office / notebook text paths. Default ${DEFAULT_MAX_CHARS}. Raise only when the previous Read returned truncated:true and you genuinely need more text.`),
})

type FileReadInput = z.infer<typeof inputSchema>

export type FileReadStructuredOutput = {
  filePath: string
  format: string
  searchHint?: string
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

/** Marker for dedup hits — returned when the file/range was already Read
 *  earlier in this daemon's lifetime and the file hasn't been touched.
 *  Carries no body text; the prior Read's tool_result is still in context. */
export type FileReadUnchangedOutput = {
  kind: 'unchanged'
  filePath: string
}

export type FileReadOutput =
  | FileReadStructuredOutput
  | string
  | FileReadVisualOutput
  | FileReadUnchangedOutput

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

const DESCRIPTION = [
  'Read a file from the workspace. Routes by file type:',
  '- Text / code / log / json / csv / yaml / xml etc: returns line-numbered output. Optional `offset` + `limit` (line-based) for paging.',
  '- PDF (text path, default): returns extracted text via pdftotext layout mode, capped by `max_chars` (default 50000).',
  '- PDF (visual path): pass `pages` ("1", "1-5", "10-12") to render via pdftoppm and emit inline image blocks for the main model (or sub-LLM-described text on non-vision endpoints). Max 20 pages per call.',
  '- Image (.jpg/.png/.gif/.webp): returns inline image block. Resize is automatic — no knob to tune.',
  '- Office (.xlsx/.docx/.pptx): auto-extracts via sandbox parser. For .xlsx pass `xlsx: { sheet, range, max_rows, max_cols }` to narrow the view.',
  '- Jupyter notebook (.ipynb): cells flattened into structured text with code/markdown/output sections.',
  '- Binary (.zip/.so/.mp3/.mp4 etc): rejected with a tool-specific hint pointing to Bash + extractor.',
  'Channel attachments live under `.lightclaw/inbox/<chatId>/<file>`; web downloads under `.lightclaw/downloads/<file>`. To search inside an extracted PDF/Office document, look at the returned `text` field — do NOT call Grep on the binary file path.',
].join('\n')

export const fileReadTool = buildTool<FileReadInput, FileReadOutput>({
  name: 'Read',
  description: DESCRIPTION,
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
      const ext = path.extname(filePath).toLowerCase()

      // Up-front binary reject (Claude Code-style validateInput equivalent).
      // PDF/image/.ipynb fall through to dedicated handlers; everything else
      // on the binary reject list bounces with a tailored hint.
      if (BINARY_REJECT_EXTENSIONS.has(ext)) {
        return {
          output: binaryRejectHint(filePath, ext),
          isError: true,
        }
      }

      const probableFormat = inferArtifactFormat(filePath, undefined)

      // Image files: visual path. Always emit image block (finalization
      // handles non-vision endpoints by replacing with describe-text).
      if (isVisualImageExtension(filePath)) {
        return await readImageVisual(filePath, context)
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
        || probableFormat === 'notebook'
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

        // Dedup: identical (path, mtime, xlsx-spec hash, max_chars) is a
        // cache hit. Plain text dedup runs in its own path below.
        const dedupVariant = buildExtractDedupVariant(input, probableFormat)
        if (hasBeenRead({ filePath, mtimeMs: stat.mtimeMs, variant: dedupVariant })) {
          return { output: { kind: 'unchanged' as const, filePath } }
        }

        const buffer = await context.runtime.fs.readFile(filePath)
        const extraction = await extractArtifactText({
          buffer,
          filePath,
          maxChars: input.max_chars ?? DEFAULT_MAX_CHARS,
          xlsx: input.xlsx
            ? {
                sheet: input.xlsx.sheet,
                range: input.xlsx.range,
                maxRows: input.xlsx.max_rows,
                maxCols: input.xlsx.max_cols,
              }
            : undefined,
          exec: params => context.runtime.exec(params),
        })
        markRead({ filePath, mtimeMs: stat.mtimeMs, variant: dedupVariant })
        return {
          output: {
            filePath,
            format: extraction.format,
            // Anti-Grep breadcrumb: PDF/Office/notebook text is extracted by an
            // external tool (pdftotext / openpyxl / python-docx / python-pptx /
            // ipynb JSON.parse), not stored as plain text on disk. Without this
            // hint, agents routinely see the extracted text, lose track of
            // "this came from a binary container", then try Grep on filePath
            // to search a keyword and get an empty result (Bug 6 in 2026-05-10
            // audit). Notebook is plain JSON on disk so Grep would technically
            // work, but the structured format expected by the agent is the
            // extraction output, not raw JSON — still discourage Grep on path.
            searchHint:
              `To search inside this ${extraction.format} for a keyword, `
              + 'do NOT call Grep on the filePath above. '
              + 'Look at the returned `text` field directly'
              + (probableFormat === 'pdf'
                ? ', or call this Read again with `pages=` to render specific pages.'
                : '.'),
            text: extraction.text,
            truncated: extraction.truncated,
            sizeBytes: buffer.length,
            warnings: extraction.warnings,
            metadata: extraction.metadata,
          },
        }
      }

      // Plain text path. Dedup keyed on (path, mtime, offset, limit).
      const plainStat = await context.runtime.fs.stat(filePath)
      const plainVariant = `plain:off=${input.offset ?? 1}:lim=${input.limit ?? '*'}`
      if (
        plainStat.isFile
        && hasBeenRead({ filePath, mtimeMs: plainStat.mtimeMs, variant: plainVariant })
      ) {
        return { output: { kind: 'unchanged' as const, filePath } }
      }
      const content = (await context.runtime.fs.readFile(filePath)).toString('utf8')
      if (plainStat.isFile) {
        markRead({ filePath, mtimeMs: plainStat.mtimeMs, variant: plainVariant })
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
  formatResult(output, toolUseId, isError): UserToolResultBlock {
    if (typeof output === 'object' && output !== null && 'kind' in output) {
      if (output.kind === 'visual') {
        return {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: output.toolResultContent,
          ...(isError ? { is_error: true } : {}),
        }
      }
      if (output.kind === 'unchanged') {
        return {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content:
            `[Read] ${output.filePath} unchanged since last Read in this daemon. `
            + 'The earlier tool_result with the actual content is still in context — refer to that instead of re-reading.',
          ...(isError ? { is_error: true } : {}),
        }
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

/** Build the dedup variant key for the extracted-text branch. Includes
 *  xlsx options because the extracted text depends on them (different
 *  sheet/range = different content). max_chars is included so a smaller
 *  scan followed by a larger one doesn't dedup. */
function buildExtractDedupVariant(input: FileReadInput, format: string): string {
  const parts: string[] = [`extract:${format}`, `chars=${input.max_chars ?? DEFAULT_MAX_CHARS}`]
  if (format === 'xlsx' && input.xlsx) {
    parts.push(`sheet=${input.xlsx.sheet ?? ''}`)
    parts.push(`range=${input.xlsx.range ?? ''}`)
    parts.push(`rows=${input.xlsx.max_rows ?? ''}`)
    parts.push(`cols=${input.xlsx.max_cols ?? ''}`)
  }
  return parts.join(';')
}

async function readImageVisual(
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
    targetBytes: resolveResizeTarget({ pageCount: 1 }),
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

    // Per-page resize budget scales down as page count grows (see
    // resolveResizeTarget docstring). Compute once per Read call.
    const targetBytes = resolveResizeTarget({ pageCount: imageFiles.length })

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
        targetBytes,
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
