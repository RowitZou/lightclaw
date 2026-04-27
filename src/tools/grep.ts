import path from 'node:path'

import { z } from 'zod'

import { buildTool } from '../tool.js'
import type { Runtime } from '../runtime/index.js'

const MAX_OUTPUT_CHARS = 30000

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
  description: 'Search file contents with ripgrep or grep.',
  riskLevel: 'safe',
  concurrencySafe: true,
  inputSchema: z.object({
    pattern: z.string().min(1),
    path: z.string().optional(),
    include: z.string().optional(),
  }),
  async call(input, context) {
    const searchPath = resolveInputPath(context.cwd, input.path)

    try {
      const rgArgs = ['-n', '--no-heading', '--color', 'never']
      if (input.include) {
        rgArgs.push('-g', input.include)
      }
      rgArgs.push(input.pattern, searchPath)
      const result = await runSearch(
        'rg',
        rgArgs,
        context.cwd,
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
            context.cwd,
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
