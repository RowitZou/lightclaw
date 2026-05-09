import { randomUUID } from 'node:crypto'
import path from 'node:path'

import { getConfig } from '../config.js'
import type { ToolCallContext } from '../tool.js'

/** Pre-resize cap for image bytes — runtime read refuses files over this
 *  to bound memory; the resize gate further trims successful reads to
 *  ~`attachments.imageMaxMb`. */
export const MAX_IMAGE_BYTES = 100 * 1024 * 1024

/** Hard upper bound on PDF byte size that the visual renderer will
 *  accept. Above this we throw a "Read refused" — agent must
 *  use Read text path or split the file externally. */
export const MAX_PDF_BYTES = 100 * 1024 * 1024

/** Per-Read-call cap on rendered PDF pages. Beyond this the schema
 *  rejects to avoid runaway describeImage cost — agent splits with
 *  multiple `pages='N-M'` calls. */
export const MAX_PAGES_PER_READ = 20

/** Default page range when `pages` is omitted. Render the first N pages
 *  of any PDF whose page count we can detect; cap to total pages when
 *  the document is shorter. */
export const DEFAULT_RENDER_PAGES = 3

/** Maximum value the LLM can request for `resize_target_mb`. Caps the
 *  base64 payload sent to the vision model so a runaway prompt cannot
 *  produce unbounded uploads. */
export const MAX_RESIZE_TARGET_MB = 16

const PDF_HEADER = '%PDF-'

export function parsePdfPageRange(
  pages: string,
): { firstPage: number; lastPage: number | 'end' } | null {
  const trimmed = pages.trim()
  if (!trimmed) return null
  if (trimmed.endsWith('-')) {
    const first = Number.parseInt(trimmed.slice(0, -1), 10)
    if (!Number.isInteger(first) || first < 1) return null
    return { firstPage: first, lastPage: 'end' }
  }
  const dash = trimmed.indexOf('-')
  if (dash < 0) {
    const page = Number.parseInt(trimmed, 10)
    if (!Number.isInteger(page) || page < 1) return null
    return { firstPage: page, lastPage: page }
  }
  const first = Number.parseInt(trimmed.slice(0, dash), 10)
  const last = Number.parseInt(trimmed.slice(dash + 1), 10)
  if (
    !Number.isInteger(first)
    || !Number.isInteger(last)
    || first < 1
    || last < 1
    || last < first
  ) {
    return null
  }
  return { firstPage: first, lastPage: last }
}

export function resolvePageRange(
  pages: string | undefined,
  pageCount: number | undefined,
): { firstPage: number; lastPage: number; warnings: string[] } {
  const requested = pages ?? defaultPageRange(pageCount)
  const parsed = parsePdfPageRange(requested)
  if (!parsed) {
    throw new Error(`Invalid PDF page range "${requested}". Use "1", "1-5", or "10-".`)
  }
  if (parsed.lastPage === 'end' && pageCount === undefined) {
    throw new Error(
      'Open-ended PDF page ranges require pdfinfo page count support. Use a closed range such as "1-5".',
    )
  }
  const warnings: string[] = []
  const firstPage = parsed.firstPage
  let lastPage = parsed.lastPage === 'end' ? pageCount! : parsed.lastPage
  if (pageCount !== undefined) {
    if (firstPage > pageCount) {
      throw new Error(
        `PDF page range starts at ${firstPage}, but the document has only ${pageCount} page(s).`,
      )
    }
    if (lastPage > pageCount) {
      warnings.push(
        `Requested last page ${lastPage} exceeds document page count ${pageCount}; clamped to ${pageCount}.`,
      )
      lastPage = pageCount
    }
  }
  const count = lastPage - firstPage + 1
  if (count > MAX_PAGES_PER_READ) {
    throw new Error(
      `PDF page range "${requested}" includes ${count} pages; maximum is ${MAX_PAGES_PER_READ} pages per call.`,
    )
  }
  return { firstPage, lastPage, warnings }
}

function defaultPageRange(pageCount: number | undefined): string {
  return `1-${Math.min(pageCount ?? DEFAULT_RENDER_PAGES, DEFAULT_RENDER_PAGES)}`
}

export async function assertPdfHeader(
  context: ToolCallContext,
  filePath: string,
): Promise<void> {
  const result = await context.runtime.exec({
    command: 'head -c 5 "$LIGHTCLAW_PDF_PATH"',
    env: { LIGHTCLAW_PDF_PATH: filePath },
    timeoutMs: 5_000,
    maxBufferBytes: 64,
  })
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `Failed to read PDF header: ${filePath}`)
  }
  if (!result.stdout.startsWith(PDF_HEADER)) {
    throw new Error(`File is not a valid PDF (missing %PDF- header): ${filePath}`)
  }
}

export async function getPdfPageCount(
  context: ToolCallContext,
  filePath: string,
): Promise<number | undefined> {
  const result = await context.runtime.exec({
    command:
      'command -v pdfinfo >/dev/null 2>&1 || exit 127; pdfinfo "$LIGHTCLAW_PDF_PATH"',
    env: { LIGHTCLAW_PDF_PATH: filePath },
    timeoutMs: 10_000,
    maxBufferBytes: 64 * 1024,
  })
  if (result.exitCode !== 0) {
    return undefined
  }
  const match = /^Pages:\s+(\d+)/m.exec(result.stdout)
  if (!match) return undefined
  const pageCount = Number.parseInt(match[1]!, 10)
  return Number.isFinite(pageCount) && pageCount > 0 ? pageCount : undefined
}

export async function renderPdfPages(
  context: ToolCallContext,
  input: { filePath: string; outputDir: string; firstPage: number; lastPage: number },
): Promise<void> {
  const result = await context.runtime.exec({
    command:
      'command -v pdftoppm >/dev/null 2>&1 || exit 127; '
      + 'mkdir -p "$LIGHTCLAW_PDF_OUTPUT_DIR"; '
      + 'pdftoppm -jpeg -r 100 -f "$LIGHTCLAW_PDF_FIRST" -l "$LIGHTCLAW_PDF_LAST" '
      + '"$LIGHTCLAW_PDF_PATH" "$LIGHTCLAW_PDF_OUTPUT_DIR/page"',
    env: {
      LIGHTCLAW_PDF_PATH: input.filePath,
      LIGHTCLAW_PDF_OUTPUT_DIR: input.outputDir,
      LIGHTCLAW_PDF_FIRST: String(input.firstPage),
      LIGHTCLAW_PDF_LAST: String(input.lastPage),
    },
    timeoutMs: 120_000,
    maxBufferBytes: 512 * 1024,
  })
  if (result.exitCode === 127) {
    throw new Error(
      'pdftoppm is not installed in this runtime. Install poppler-utils to inspect PDF pages visually.',
    )
  }
  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim()
    if (/password/i.test(stderr)) {
      throw new Error('PDF is password-protected. Please provide an unprotected version.')
    }
    if (/damaged|corrupt|invalid/i.test(stderr)) {
      throw new Error('PDF file is corrupted or invalid.')
    }
    throw new Error(stderr || 'pdftoppm failed.')
  }
}

export async function cleanupPdfPageDir(
  context: ToolCallContext,
  outputDir: string,
): Promise<string | undefined> {
  const result = await context.runtime.exec({
    command: 'rm -rf "$LIGHTCLAW_PDF_OUTPUT_DIR"',
    env: { LIGHTCLAW_PDF_OUTPUT_DIR: outputDir },
    timeoutMs: 10_000,
    maxBufferBytes: 64 * 1024,
  })
  if (result.exitCode !== 0) {
    return `Failed to clean up temporary PDF page images: ${result.stderr.trim() || result.stdout.trim()}`
  }
  return undefined
}

export function pageNumberFromImageName(fileName: string): number | undefined {
  const match = /-(\d+)\.jpe?g$/i.exec(fileName)
  if (!match) return undefined
  const value = Number.parseInt(match[1]!, 10)
  return Number.isFinite(value) ? value : undefined
}

export function comparePdfPageImageNames(a: string, b: string): number {
  return (pageNumberFromImageName(a) ?? 0) - (pageNumberFromImageName(b) ?? 0)
    || a.localeCompare(b)
}

export function buildPdfPageOutputDir(workspaceRoot: string): string {
  return path.posix.join(workspaceRoot, '.lightclaw', 'tmp', 'pdf-pages', randomUUID())
}

/** Resolve the resize target bytes for a single Read visual call. The
 *  LLM-supplied `resize_target_mb` overrides; otherwise we default to the
 *  global `attachments.imageMaxMb` from config so this stays in sync with
 *  the inline-submission resize policy across providers. */
export function resolveResizeTarget(overrideMb: number | undefined): number {
  if (overrideMb !== undefined) {
    return overrideMb * 1024 * 1024
  }
  const cfg = getConfig().attachments
  return cfg.imageMaxMb * 1024 * 1024
}

export const VISUAL_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
])

export function isVisualImageExtension(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase()
  return VISUAL_EXTENSIONS.has(ext)
}
