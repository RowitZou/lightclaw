import path from 'node:path'

import { z } from 'zod'

import { buildTool } from '../tool.js'
import type { Runtime } from '../runtime/index.js'

const MAX_OUTPUT_CHARS = 30000

/**
 * Extensions ripgrep treats as binary (skips by default → exit 1, "no matches").
 * Without intercept, the agent sees `[no matches found]`, assumes its keyword
 * is wrong, and retries with different keywords forever (Bug 6 in the
 * 2026-05-10 audit — Q11 turn=2/4 both Grepped a PDF and looped). The list
 * is intentionally narrow: only file types where Grep is unambiguously wrong
 * (binary office docs, PDFs, images, audio/video, archives, native binaries).
 * Source files of any flavor still go to ripgrep; the directory case (Grep
 * over a tree containing some PDFs) is handled by ripgrep's own binary skip.
 */
const BINARY_EXTENSIONS = new Set([
  '.pdf',
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.svg',
  '.mp3', '.wav', '.flac', '.ogg', '.m4a',
  '.mp4', '.avi', '.mov', '.mkv', '.webm',
  '.zip', '.tar', '.tgz', '.gz', '.bz2', '.xz', '.7z', '.rar',
  '.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp',
  '.so', '.o', '.a', '.dylib', '.dll', '.exe', '.bin',
  '.pyc', '.pyo', '.class', '.jar', '.wasm',
])

function isKnownBinaryFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase()
  return BINARY_EXTENSIONS.has(ext)
}

function binaryHint(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  // Tailored next-step guidance per kind. PDF gets the concrete `pages=`
  // recipe because that's the most common Grep-on-PDF mistake shape; images
  // get the visual-Read note; everything else gets a generic Read fallback.
  if (ext === '.pdf') {
    return (
      `Grep does not yield results on binary file ${filePath} ` +
      `(ripgrep skips binary files by default, so a "no matches" exit is uninformative). ` +
      `For PDF, call Read({ file_path: "${filePath}" }) for pdftotext extraction (cheap, ` +
      `text-based PDFs only) or Read({ file_path: "${filePath}", pages: "1-5" }) for ` +
      `visual rendering of specific pages (image-based / scanned PDFs).`
    )
  }
  if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.svg'].includes(ext)) {
    return (
      `Grep does not yield results on binary file ${filePath} ` +
      `(ripgrep skips images). Call Read({ file_path: "${filePath}" }) to view the image.`
    )
  }
  return (
    `Grep does not yield results on binary file ${filePath} ` +
    `(extension "${ext}" is treated as binary; ripgrep skips it). ` +
    `Use Read on the file directly, or run Bash with the appropriate extractor ` +
    `(e.g. unzip -p / strings / docx2txt) and grep the extracted text.`
  )
}

function resolveInputPath(cwd: string, inputPath?: string): string {
  if (!inputPath) {
    return cwd
  }

  return path.isAbsolute(inputPath) ? inputPath : path.resolve(cwd, inputPath)
}

function truncateOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_CHARS) {
    return output
  }

  return `${output.slice(0, MAX_OUTPUT_CHARS)}\n\n[output truncated; narrow the pattern or path]`
}

async function runSearch(
  binary: 'rg' | 'grep',
  args: string[],
  cwd: string,
  runtime: Runtime,
  signal: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const command = [binary, ...args.map(shellQuote)].join(' ')
  const result = await runtime.exec({
    command,
    cwd,
    abortSignal: signal,
    maxBufferBytes: 1024 * 1024,
  })
  return {
    stdout: result.stdout.trimEnd(),
    stderr: result.stderr,
    exitCode: result.exitCode,
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function isCommandNotFound(result: { stderr: string; exitCode: number }): boolean {
  return result.exitCode === 127 && result.stderr.includes('command not found')
}

export const grepTool = buildTool({
  name: 'Grep',
  description:
    'Search file contents with ripgrep or grep. For binary files (PDF, images, audio, video, archives, office documents), use Read with appropriate parameters instead — Grep returns empty (ripgrep skips binary by default) and provides no signal you can act on.',
  domain: 'environment',
  riskLevel: 'safe',
  concurrencySafe: true,
  inputSchema: z.object({
    pattern: z.string().min(1),
    path: z.string().optional(),
    include: z.string().optional(),
  }),
  async call(input, context) {
    const searchPath = resolveInputPath(context.runtime.workspaceRoot, input.path)

    // Short-circuit when the user pointed Grep directly at a known-binary file.
    // The directory case (Grep . over a tree containing some PDFs) still goes
    // through ripgrep — its own binary skip handles that path correctly, and
    // we don't want to refuse a legitimate `Grep("foo")` over a mixed tree.
    if (input.path && isKnownBinaryFile(searchPath)) {
      return {
        output: binaryHint(searchPath),
        isError: true,
      }
    }

    try {
      const rgArgs = ['-n', '--no-heading', '--color', 'never']
      if (input.include) {
        rgArgs.push('-g', input.include)
      }
      rgArgs.push(input.pattern, searchPath)
      const result = await runSearch(
        'rg',
        rgArgs,
        context.runtime.workspaceRoot,
        context.runtime,
        context.abortSignal,
      )

      if (result.exitCode === 0) {
        return {
          output: truncateOutput(result.stdout || '[no matches found]'),
        }
      }

      if (result.exitCode === 1) {
        return { output: '[no matches found]' }
      }

      if (isCommandNotFound(result)) {
        try {
          const grepArgs = ['-rn']
          if (input.include) {
            grepArgs.push(`--include=${input.include}`)
          }
          grepArgs.push(input.pattern, searchPath)
          const fallback = await runSearch(
            'grep',
            grepArgs,
            context.runtime.workspaceRoot,
            context.runtime,
            context.abortSignal,
          )
          if (fallback.exitCode === 0) {
            return {
              output: truncateOutput(fallback.stdout || '[no matches found]'),
            }
          }
          if (fallback.exitCode === 1) {
            return { output: '[no matches found]' }
          }
          return {
            output: fallback.stderr.trim() || `grep exited with code ${fallback.exitCode}`,
            isError: true,
          }
        } catch (fallbackError) {
          return {
            output:
              fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
            isError: true,
          }
        }
      }

      return {
        output: result.stderr.trim() || `rg exited with code ${result.exitCode}`,
        isError: true,
      }
    } catch (error) {
      return {
        output: error instanceof Error ? error.message : String(error),
        isError: true,
      }
    }
  },
})
