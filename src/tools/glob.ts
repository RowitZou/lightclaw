import path from 'node:path'

import fg from 'fast-glob'
import { z } from 'zod'

import { buildTool } from '../tool.js'

function resolveInputPath(cwd: string, inputPath?: string): string {
  if (!inputPath) {
    return cwd
  }

  return path.isAbsolute(inputPath) ? inputPath : path.resolve(cwd, inputPath)
}

export const globTool = buildTool({
  name: 'Glob',
  description: 'Find files by glob pattern.',
  inputSchema: z.object({
    pattern: z.string().min(1),
    path: z.string().optional(),
  }),
  async call(input, context) {
    try {
      const cwd = resolveInputPath(context.cwd, input.path)
      const matches = await fg(input.pattern, {
        cwd,
        dot: true,
        onlyFiles: false,
      })
      return {
        output: matches.length > 0 ? matches.join('\n') : '[no files matched]',
      }
    } catch (error) {
      return {
        output: error instanceof Error ? error.message : String(error),
        isError: true,
      }
    }
  },
})