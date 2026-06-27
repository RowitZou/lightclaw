import path from 'node:path'

import { z } from 'zod'

import {
  extractArtifactText,
  inferArtifactFormat,
} from '../artifacts/extractors/registry.js'
import { inspectImageBuffer } from '../artifacts/media/image.js'
import {
  buildPdfSliceOutputPath,
  cleanupPdfSliceDir,
  slicePdfPages,
} from '../artifacts/media/pdf-slice.js'
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
  parsePdfPageRange,
  renderPdfPages,
  resolvePageRange,
  resolveResizeTarget,
} from '../artifacts/visual-rendering.js'
import { suggestPathRules } from '../permission/suggestions.js'
import { readCacheEntry } from '../provider/capability-cache.js'
import type { Readable } from 'node:stream'
import { buildTool, type ToolCallContext } from '../tool.js'
import type { ToolResultContentBlock, UserToolResultBlock } from '../types.js'

import { hasBeenRead, markRead } from './read-dedup.js'

const DEFAULT_MAX_CHARS = 50_000
const MAX_MAX_CHARS = 100_000

/** Resolve the effective extracted-text char cap. An absent value falls back
 *  to the default; a value above the hard ceiling is clamped down (not
 *  rejected at the schema layer) so a model migrating a large `max_chars`
 *  from another read tool gets capped content + a warning instead of a hard
 *  validation failure that forces a retry. */
function resolveMaxChars(requested: number | undefined): { maxChars: number; clamped: boolean } {
  const value = requested ?? DEFAULT_MAX_CHARS
  if (value > MAX_MAX_CHARS) return { maxChars: MAX_MAX_CHARS, clamped: true }
  return { maxChars: value, clamped: false }
}
const MAX_OFFICE_BYTES = 20 * 1024 * 1024
const MAX_INLINE_PDF_BYTES = 20 * 1024 * 1024

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
    .describe(`PDF only — page selector "1" / "1-5" / "10-12" to read just those pages. Default returns the extracted text of that range via pdftotext (cheap, exact). Pass \`visual: true\` to send the selected pages as inline PDF when the main model supports it, otherwise render pages as inline images via pdftoppm. Max ${MAX_PAGES_PER_READ} pages per call in either mode. Without \`pages\`, PDFs return the whole document's text capped by \`max_chars\`.`),
  visual: z.boolean().optional()
    .describe('PDF + `pages` only — when true, prefer inline PDF document output if pdf@inToolResult is enabled; otherwise render selected pages as inline images via pdftoppm. When false / omitted, returns the page-range text via pdftotext. No effect without `pages`.'),
  xlsx: z.object({
    sheet: z.string().min(1).optional().describe('Sheet name (defaults to first sheet).'),
    range: z.string().min(1).optional().describe('A1:D20 style cell range.'),
    max_rows: z.number().int().min(1).max(1000).optional().describe('Cap on rows returned (default 50).'),
    max_cols: z.number().int().min(1).max(200).optional().describe('Cap on columns returned (default 20).'),
  }).optional().describe('xlsx-specific options. Ignored for non-spreadsheet files.'),
  max_chars: z.number().int().min(1).optional()
    .describe(`Cap on extracted text characters for PDF / Office / notebook text paths. Default ${DEFAULT_MAX_CHARS}, hard ceiling ${MAX_MAX_CHARS} (values above are clamped down, not rejected — a warning is returned). Raise only when the previous Read returned truncated:true and you genuinely need more text.`),
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

type PlainTextRead = { text: string; truncated: boolean }

type PlainTextState = {
  parts: string[]
  chars: number
  lineNo: number
  selected: number
  truncated: boolean
}

/** Render one line into the line-numbered, char-capped accumulator. Returns
 *  'stop' once `limit` lines or the MAX_MAX_CHARS budget is reached. Char
 *  counting is UTF-16 code units (JS `.length`), matching the historical
 *  formatLines + the `+1` per inter-line newline. */
function emitPlainTextLine(
  state: PlainTextState,
  line: string,
  offset: number,
  limit: number | undefined,
): 'continue' | 'stop' {
  state.lineNo += 1
  if (state.lineNo < offset) return 'continue'
  if (limit !== undefined && state.selected >= limit) return 'stop'
  const rendered = `${String(state.lineNo).padStart(6, ' ')} | ${line}`
  const extra = rendered.length + (state.parts.length > 0 ? 1 : 0)
  if (state.chars + extra > MAX_MAX_CHARS) {
    state.truncated = true
    return 'stop'
  }
  state.parts.push(rendered)
  state.chars += extra
  state.selected += 1
  return 'continue'
}

function finalizePlainText(state: PlainTextState): PlainTextRead {
  return {
    text: state.parts.length > 0 ? state.parts.join('\n') : '[no lines selected]',
    truncated: state.truncated,
  }
}

/** Daemon-side text read: line-numbered output capped at MAX_MAX_CHARS,
 *  reading only as far as the cap requires (bounded memory, no whole-file
 *  buffer). In-workspace / shared paths stream the gpfs file directly
 *  (zero-copy, no worker exec); container-local / worker-only-mount paths
 *  stream a relay-staged copy. Backends/paths without a stream accessor fall
 *  back to a bounded whole-file read with identical cap logic. */
async function readPlainTextStreamed(
  context: ToolCallContext,
  filePath: string,
  offset: number,
  limit?: number,
): Promise<PlainTextRead> {
  const make = context.runtime.fs.createReadStream
  if (make) {
    let stream: Readable | null = null
    try {
      stream = await make.call(context.runtime.fs, filePath)
    } catch {
      // No stream accessor for this path (e.g. an exec-relay layer without
      // createReadStream): fall through to the buffered read below.
      stream = null
    }
    if (stream) return readPlainTextFromStream(stream, offset, limit)
  }
  const content = (await context.runtime.fs.readFile(filePath)).toString('utf8')
  return readPlainTextFromBuffer(content, offset, limit)
}

function readPlainTextFromBuffer(
  content: string,
  offset: number,
  limit: number | undefined,
): PlainTextRead {
  const state: PlainTextState = { parts: [], chars: 0, lineNo: 0, selected: 0, truncated: false }
  for (const line of content.split(/\r?\n/)) {
    if (emitPlainTextLine(state, line, offset, limit) === 'stop') break
  }
  return finalizePlainText(state)
}

async function readPlainTextFromStream(
  stream: Readable,
  offset: number,
  limit: number | undefined,
): Promise<PlainTextRead> {
  stream.setEncoding('utf8')
  const state: PlainTextState = { parts: [], chars: 0, lineNo: 0, selected: 0, truncated: false }
  let buf = ''
  let stopped = false
  try {
    outer: for await (const chunk of stream as AsyncIterable<string>) {
      buf += chunk
      let match: RegExpExecArray | null
      while ((match = /\r?\n/.exec(buf)) !== null) {
        const line = buf.slice(0, match.index)
        buf = buf.slice(match.index + match[0].length)
        if (emitPlainTextLine(state, line, offset, limit) === 'stop') {
          stopped = true
          break outer
        }
      }
      // Bound memory on a single line longer than the whole cap.
      if (buf.length > MAX_MAX_CHARS) {
        if (state.lineNo + 1 >= offset && (limit === undefined || state.selected < limit)) {
          emitPlainTextLine(state, buf, offset, limit) // exceeds cap → truncated → stop
          stopped = true
          break outer
        }
        // A skipped (pre-offset) line: discard its content; its terminating
        // newline still advances lineNo when it arrives.
        buf = ''
      }
    }
  } finally {
    stream.destroy()
  }
  if (!stopped) {
    // Final segment after the last newline — always emitted to mirror
    // `content.split(/\r?\n/)` (a trailing newline yields an empty final line).
    emitPlainTextLine(state, buf, offset, limit)
  }
  return finalizePlainText(state)
}

const DESCRIPTION = [
  'Read a file from the workspace. Routes by file type:',
  '- Text / code / log / json / csv / yaml / xml etc: returns line-numbered output, capped at 100000 characters. Optional `offset` + `limit` (line-based) for paging; past the cap, page with `offset`/`limit` or scan with Bash (`rg`/`sed`).',
  '- PDF (whole document, default): returns extracted text via pdftotext layout mode, capped by `max_chars` (default 50000). Use this for short PDFs or to skim the start of a long one.',
  '- PDF (specific pages, text — preferred for long docs): pass `pages` ("1", "1-5", "31-31") and the tool returns just those pages\' text via pdftotext `-f -l`. Lets you jump straight to a numbered section (e.g. "go read page 31") without paying full-document `max_chars`.',
  '- PDF (specific pages, visual): pass `pages` AND `visual: true` to prefer inline PDF document output on models that support pdf@inToolResult, falling back to pdftoppm inline image blocks otherwise (figures, formulas, scanned-only PDFs, complex layouts where text extraction loses structure). Max 20 pages per call.',
  '- Image (.jpg/.png/.gif/.webp): returns inline image block. Resize is automatic — no knob to tune.',
  '- Office (.xlsx/.docx/.pptx): auto-extracts via sandbox parser. For .xlsx pass `xlsx: { sheet, range, max_rows, max_cols }` to narrow the view.',
  '- Jupyter notebook (.ipynb): cells flattened into structured text with code/markdown/output sections.',
  '- Binary (.zip/.so/.mp3/.mp4 etc): rejected with a tool-specific hint pointing to Bash + extractor.',
  'Channel attachments live under `.lightclaw/inbox/<chatId>/<file>`; web downloads under `.lightclaw/downloads/<file>`. To search inside an extracted PDF/Office document, look at the returned `text` field — do NOT call Grep on the binary file path.',
].join('\n')

export const fileReadTool = buildTool<FileReadInput, FileReadOutput>({
  name: 'Read',
  whenToUse: `Read a known file path; routes by type (text / PDF / image / Office / Jupyter notebook).`,
  alwaysLoad: true,
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

      // PDF + pages + visual=true: pdftoppm visual path. PDF + pages alone
      // defaults to the page-range text path below (pdftotext -f -l), so the
      // model gets exact text by default and only opts into the image
      // rendering when it actually wants figures / formulas / scanned
      // content. Without `pages` at all we still walk into the text branch
      // below and dump the whole document, capped by max_chars.
      if (probableFormat === 'pdf' && input.pages !== undefined && input.visual === true) {
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

        // PDF text path with `pages`: resolve the page selector to a closed
        // inclusive range and hand it to the extractor as `-f N -l M`. We
        // don't query pdfinfo for the document page count here — pdftotext
        // tolerates out-of-bounds `-l` by stopping at the last page, and
        // skipping the round-trip keeps "Read page 31" a single exec call.
        // Open-ended selectors ("31-") cap at firstPage + MAX_PAGES_PER_READ - 1
        // so a careless prompt does not stream the rest of a 400-page book.
        let pdfPageRange: { firstPage: number; lastPage: number } | undefined
        if (probableFormat === 'pdf' && input.pages !== undefined) {
          const parsed = parsePdfPageRange(input.pages)
          if (!parsed) {
            return {
              output: `Invalid PDF page selector "${input.pages}". Use "1", "1-5", "31-31", or "31-".`,
              isError: true,
            }
          }
          const firstPage = parsed.firstPage
          const lastPage = parsed.lastPage === 'end'
            ? firstPage + MAX_PAGES_PER_READ - 1
            : Math.min(parsed.lastPage, firstPage + MAX_PAGES_PER_READ - 1)
          pdfPageRange = { firstPage, lastPage }
        }

        // Clamp an over-ceiling max_chars down rather than rejecting it.
        const { maxChars, clamped: maxCharsClamped } = resolveMaxChars(input.max_chars)

        // Dedup: identical (path, mtime, xlsx-spec hash, max_chars, pdf
        // page range) is a cache hit. Plain text dedup runs in its own
        // path below.
        const dedupVariant = buildExtractDedupVariant(input, probableFormat, pdfPageRange, maxChars)
        if (hasBeenRead({ filePath, mtimeMs: stat.mtimeMs, variant: dedupVariant })) {
          return { output: { kind: 'unchanged' as const, filePath } }
        }

        const buffer = await context.runtime.fs.readFile(filePath)
        const extraction = await extractArtifactText({
          buffer,
          filePath,
          maxChars,
          xlsx: input.xlsx
            ? {
                sheet: input.xlsx.sheet,
                range: input.xlsx.range,
                maxRows: input.xlsx.max_rows,
                maxCols: input.xlsx.max_cols,
              }
            : undefined,
          pdfPageRange,
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
                ? ', or call Read again with `pages="N"` / `"N-M"` to fetch a specific page range\'s text (add `visual: true` for image rendering).'
                : '.'),
            text: extraction.text,
            truncated: extraction.truncated,
            sizeBytes: buffer.length,
            warnings: maxCharsClamped
              ? [
                  `max_chars=${input.max_chars} exceeds the ${MAX_MAX_CHARS} ceiling for Read; clamped to ${MAX_MAX_CHARS}. For more text use \`pages\` (PDF) or read in ranges via \`offset\`/\`limit\`.`,
                  ...extraction.warnings,
                ]
              : extraction.warnings,
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
      const streamed = await readPlainTextStreamed(
        context,
        filePath,
        input.offset ?? 1,
        input.limit,
      )
      if (plainStat.isFile) {
        markRead({ filePath, mtimeMs: plainStat.mtimeMs, variant: plainVariant })
      }
      if (streamed.truncated) {
        streamed.text += '\n\n[Output truncated at 100000 characters. Read more via `offset`/`limit` (line-based) or scan with Bash (`rg`/`sed`).]'
        return {
          output: {
            filePath,
            format: 'text',
            text: streamed.text,
            truncated: true,
            sizeBytes: plainStat.size,
            warnings: [],
          },
        }
      }
      return {
        output: streamed.text,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/ENOENT|no such file/i.test(message)) {
        const basename = path.basename(input.file_path)
        return {
          output:
            `${message}\n\n` +
            `[Hint: file does not exist. Try Glob with pattern '**/${basename}' to find similar paths, ` +
            `or list the parent directory via Bash (e.g. \`ls\`) if you're guessing the location.]`,
          isError: true,
        }
      }
      return {
        output: message,
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
 *  xlsx options + pdf page range because the extracted text depends on
 *  them (different sheet/range or different pages = different content).
 *  max_chars is included so a smaller scan followed by a larger one
 *  doesn't dedup. */
function buildExtractDedupVariant(
  input: FileReadInput,
  format: string,
  pdfPageRange: { firstPage: number; lastPage: number } | undefined,
  resolvedMaxChars: number,
): string {
  const parts: string[] = [`extract:${format}`, `chars=${resolvedMaxChars}`]
  if (format === 'xlsx' && input.xlsx) {
    parts.push(`sheet=${input.xlsx.sheet ?? ''}`)
    parts.push(`range=${input.xlsx.range ?? ''}`)
    parts.push(`rows=${input.xlsx.max_rows ?? ''}`)
    parts.push(`cols=${input.xlsx.max_cols ?? ''}`)
  }
  if (format === 'pdf' && pdfPageRange) {
    parts.push(`pdfPages=${pdfPageRange.firstPage}-${pdfPageRange.lastPage}`)
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
  let sliceDirToCleanup: string | undefined
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
    const inlinePdf = await maybeReadPdfVisualAsInlineDocument({
      context,
      filePath,
      statSize: stat.size,
      pageCount,
      range,
    })
    if (inlinePdf) {
      sliceDirToCleanup = inlinePdf.cleanupDir
      return { output: inlinePdf.output }
    }
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
    if (sliceDirToCleanup) {
      await cleanupPdfSliceDir(context, sliceDirToCleanup).catch(() => undefined)
    }
  }
}

async function maybeReadPdfVisualAsInlineDocument(input: {
  context: ToolCallContext
  filePath: string
  statSize: number
  pageCount: number | undefined
  range: { firstPage: number; lastPage: number; warnings: string[] }
}): Promise<{
  output: FileReadVisualOutput
  cleanupDir?: string
} | null> {
  const routing = input.context.mainTurnRouting
  if (!routing) return null
  const entry = readCacheEntry({
    endpoint: routing.endpoint,
    baseUrl: routing.endpointBaseUrl,
    upstreamModel: routing.upstreamModel,
    kind: 'pdf',
    position: 'inToolResult',
  })
  if (entry?.enabled !== true) return null

  let pdfBuffer: Buffer
  let cleanupDir: string | undefined
  if (input.range.firstPage === 1 && input.pageCount !== undefined && input.range.lastPage === input.pageCount) {
    if (input.statSize > MAX_INLINE_PDF_BYTES) return null
    pdfBuffer = await input.context.runtime.fs.readFile(input.filePath)
  } else {
    const slice = buildPdfSliceOutputPath(input.context.runtime.workspaceRoot)
    cleanupDir = slice.outputDir
    await slicePdfPages(input.context, {
      filePath: input.filePath,
      outputDir: slice.outputDir,
      outputPath: slice.outputPath,
      firstPage: input.range.firstPage,
      lastPage: input.range.lastPage,
    })
    const sliceStat = await input.context.runtime.fs.stat(slice.outputPath)
    if (sliceStat.size > MAX_INLINE_PDF_BYTES) {
      await cleanupPdfSliceDir(input.context, cleanupDir).catch(() => undefined)
      return null
    }
    pdfBuffer = await input.context.runtime.fs.readFile(slice.outputPath)
  }

  const header: ToolResultContentBlock = {
    type: 'text',
    text: [
      `[PDF: ${path.basename(input.filePath)}]`,
      `path: ${input.filePath}`,
      `pages: ${input.range.firstPage}-${input.range.lastPage}${input.pageCount ? ` of ${input.pageCount}` : ''}`,
      'mode: inline PDF document',
      ...(input.range.warnings.length > 0 ? input.range.warnings.map(w => `note: ${w}`) : []),
    ].join('\n'),
  }
  return {
    output: {
      kind: 'visual',
      format: 'pdf',
      toolResultContent: [
        header,
        {
          type: 'document',
          source: {
            type: 'base64',
            mediaType: 'application/pdf',
            data: pdfBuffer.toString('base64'),
          },
        },
      ],
    },
    cleanupDir,
  }
}
