import path from 'node:path'

import { z } from 'zod'

import { buildTool } from '../tool.js'

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

export const fileReadTool = buildTool({
  name: 'Read',
  description: 'Read a text file, optionally with line offset and limit.',
  riskLevel: 'safe',
  concurrencySafe: true,
  inputSchema: z.object({
    file_path: z.string().min(1),
    offset: z.number().int().min(1).optional(),
    limit: z.number().int().min(1).optional(),
  }),
  async call(input, context) {
    try {
      const targetPath = resolveInputPath(context.cwd, input.file_path)
      const content = (await context.runtime.fs.readFile(targetPath)).toString('utf8')
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
