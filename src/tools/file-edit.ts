import path from 'node:path'

import { z } from 'zod'

import { suggestPathRules } from '../permission/suggestions.js'
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
  alwaysLoad: true,
  description: `Performs exact string replacements in a file. Edit is the right tool for almost all in-place changes; reach for Write only for new files or full rewrites.

Usage:
- Read the file at least once in this session before editing it. Read state is what makes \`old_string\` accurate — without it you are guessing the indentation and surrounding context.
- Read output is rendered as \`<line>\\t<content>\`. When constructing \`old_string\` from Read output, strip the line-number prefix — that prefix is display metadata, not file content. Copy the indentation AFTER the prefix exactly (tabs vs spaces matters).
- If \`old_string\` appears more than once in the file, the edit fails. Either include more surrounding context to make the match unique, OR set \`replace_all: true\` to replace every occurrence (use this for variable / symbol renames).
- Prefer editing existing files. Don't use Edit as a back-door to create new files — use Write instead.
- Avoid adding emojis to code unless the user explicitly asks.`,
  domain: 'environment',
  riskLevel: 'write',
  inputSchema: z.object({
    file_path: z.string().min(1),
    old_string: z.string().min(1),
    new_string: z.string(),
    replace_all: z.boolean().optional(),
  }),
  suggestPermissionRules(input) {
    return suggestPathRules('Edit', input.file_path)
  },
  async call(input, context) {
    try {
      const targetPath = resolveInputPath(context.runtime.workspaceRoot, input.file_path)
      const original = (await context.runtime.fs.readFile(targetPath)).toString('utf8')
      const occurrences = countOccurrences(original, input.old_string)

      if (occurrences === 0) {
        return {
          output: 'old_string was not found in the file.',
          isError: true,
        }
      }

      if (occurrences > 1 && !input.replace_all) {
        return {
          output: `old_string appears ${occurrences} times in the file. Either include more surrounding context so the match is unique, or set replace_all: true to replace every occurrence.`,
          isError: true,
        }
      }

      if (input.replace_all && occurrences > 1) {
        const nextContent = original.split(input.old_string).join(input.new_string)
        await context.runtime.fs.writeFile(targetPath, nextContent)
        return {
          output: `Applied edit to ${targetPath} (replaced ${occurrences} occurrences)`,
        }
      }

      const matchIndex = original.indexOf(input.old_string)
      const lineNumber = original.slice(0, matchIndex).split(/\r?\n/).length
      const nextContent = original.replace(input.old_string, input.new_string)
      await context.runtime.fs.writeFile(targetPath, nextContent)

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
