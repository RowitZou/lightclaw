import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { z } from 'zod'

import { buildTool } from '../tool.js'

function resolveInputPath(cwd: string, inputPath: string): string {
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(cwd, inputPath)
}

export const fileWriteTool = buildTool({
  name: 'Write',
  description: 'Create or overwrite a file with the provided content.',
  riskLevel: 'write',
  inputSchema: z.object({
    file_path: z.string().min(1),
    content: z.string(),
  }),
  async call(input, context) {
    try {
      const targetPath = resolveInputPath(context.cwd, input.file_path)
      await mkdir(path.dirname(targetPath), { recursive: true })
      await writeFile(targetPath, input.content, 'utf8')
      return {
        output: `Wrote ${Buffer.byteLength(input.content, 'utf8')} bytes to ${targetPath}`,
      }
    } catch (error) {
      return {
        output: error instanceof Error ? error.message : String(error),
        isError: true,
      }
    }
  },
})
