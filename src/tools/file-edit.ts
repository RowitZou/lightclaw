import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { z } from 'zod'

import { buildTool } from '../tool.js'

function resolveInputPath(cwd: string, inputPath: string): string {
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(cwd, inputPath)
}

function countOccurrences(content: string, needle: string): number {
  let count = 0
  let startIndex = 0
  while (true) {
    const nextIndex = content.indexOf(needle, startIndex)
    if (nextIndex === -1) {
      return count
    }
    count += 1
    startIndex = nextIndex + needle.length
  }
}

export const fileEditTool = buildTool({
  name: 'Edit',
  description: 'Replace a unique string in a file with a new string.',
  riskLevel: 'write',
  inputSchema: z.object({
    file_path: z.string().min(1),
    old_string: z.string().min(1),
    new_string: z.string(),
  }),
  async call(input, context) {
    try {
      const targetPath = resolveInputPath(context.cwd, input.file_path)
      const original = await readFile(targetPath, 'utf8')
      const occurrences = countOccurrences(original, input.old_string)

      if (occurrences === 0) {
        return {
          output: 'old_string was not found in the file.',
          isError: true,
        }
      }

      if (occurrences > 1) {
        return {
          output: 'old_string appears multiple times; provide more context to make the edit unique.',
          isError: true,
        }
      }

      const matchIndex = original.indexOf(input.old_string)
      const lineNumber = original.slice(0, matchIndex).split(/\r?\n/).length
      const nextContent = original.replace(input.old_string, input.new_string)
      await writeFile(targetPath, nextContent, 'utf8')

      return {
        output: `Applied edit to ${targetPath} at line ${lineNumber}`,
      }
    } catch (error) {
      return {
        output: error instanceof Error ? error.message : String(error),
        isError: true,
      }
    }
  },
})
