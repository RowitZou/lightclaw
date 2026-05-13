import path from 'node:path'
import { randomUUID } from 'node:crypto'

import type { ToolCallContext } from '../../tool.js'

export function buildPdfSliceOutputPath(workspaceRoot: string): {
  outputDir: string
  outputPath: string
} {
  const outputDir = path.posix.join(workspaceRoot, '.lightclaw', 'tmp', 'pdf-slices', randomUUID())
  return {
    outputDir,
    outputPath: path.posix.join(outputDir, 'selected-pages.pdf'),
  }
}

export async function slicePdfPages(
  context: ToolCallContext,
  input: {
    filePath: string
    outputDir: string
    outputPath: string
    firstPage: number
    lastPage: number
  },
): Promise<void> {
  const result = await context.runtime.exec({
    command:
      'command -v pdfseparate >/dev/null 2>&1 || exit 127; '
      + 'command -v pdfunite >/dev/null 2>&1 || exit 126; '
      + 'mkdir -p "$LIGHTCLAW_PDF_SLICE_DIR"; '
      + 'pdfseparate -f "$LIGHTCLAW_PDF_FIRST" -l "$LIGHTCLAW_PDF_LAST" '
      + '"$LIGHTCLAW_PDF_PATH" "$LIGHTCLAW_PDF_SLICE_DIR/page-%06d.pdf"; '
      + 'pdfunite "$LIGHTCLAW_PDF_SLICE_DIR"/page-*.pdf "$LIGHTCLAW_PDF_SLICE_OUTPUT"',
    env: {
      LIGHTCLAW_PDF_PATH: input.filePath,
      LIGHTCLAW_PDF_SLICE_DIR: input.outputDir,
      LIGHTCLAW_PDF_SLICE_OUTPUT: input.outputPath,
      LIGHTCLAW_PDF_FIRST: String(input.firstPage),
      LIGHTCLAW_PDF_LAST: String(input.lastPage),
    },
    timeoutMs: 120_000,
    maxBufferBytes: 512 * 1024,
  })
  if (result.exitCode === 127 || result.exitCode === 126) {
    throw new Error(
      'pdfseparate/pdfunite are not installed in this runtime. Install poppler-utils to inline selected PDF pages.',
    )
  }
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || 'PDF page slicing failed.')
  }
}

export async function cleanupPdfSliceDir(
  context: ToolCallContext,
  outputDir: string,
): Promise<void> {
  await context.runtime.exec({
    command: 'rm -rf "$LIGHTCLAW_PDF_SLICE_DIR"',
    env: { LIGHTCLAW_PDF_SLICE_DIR: outputDir },
    timeoutMs: 10_000,
    maxBufferBytes: 64 * 1024,
  })
}
