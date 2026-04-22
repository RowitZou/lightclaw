import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'

import { z } from 'zod'

import { buildTool } from '../tool.js'

const execFileAsync = promisify(execFile)
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
  signal: AbortSignal,
): Promise<string> {
  const result = await execFileAsync(binary, args, {
    cwd,
    signal,
    maxBuffer: 1024 * 1024,
  })
  return result.stdout.trimEnd()
}

export const grepTool = buildTool({
  name: 'Grep',
  description: 'Search file contents with ripgrep or grep.',
  riskLevel: 'safe',
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
      const output = await runSearch('rg', rgArgs, context.cwd, context.abortSignal)
      return {
        output: truncateOutput(output || '[no matches found]'),
      }
    } catch (error) {
      const execError = error as { code?: string | number; stdout?: string }
      if (execError.code === 'ENOENT') {
        try {
          const grepArgs = ['-rn']
          if (input.include) {
            grepArgs.push(`--include=${input.include}`)
          }
          grepArgs.push(input.pattern, searchPath)
          const output = await runSearch(
            'grep',
            grepArgs,
            context.cwd,
            context.abortSignal,
          )
          return {
            output: truncateOutput(output || '[no matches found]'),
          }
        } catch (fallbackError) {
          const fallbackExecError = fallbackError as { code?: number; message?: string }
          if (fallbackExecError.code === 1) {
            return { output: '[no matches found]' }
          }
          return {
            output:
              fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
            isError: true,
          }
        }
      }

      if (execError.code === 1) {
        return { output: '[no matches found]' }
      }

      return {
        output: error instanceof Error ? error.message : String(error),
        isError: true,
      }
    }
  },
})
