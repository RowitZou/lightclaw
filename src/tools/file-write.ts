import path from 'node:path'

import { z } from 'zod'

import { suggestPathRules } from '../permission/suggestions.js'
import { buildTool } from '../tool.js'

function resolveInputPath(cwd: string, inputPath: string): string {
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(cwd, inputPath)
}

export const fileWriteTool = buildTool({
  name: 'Write',
  description: `Create or overwrite a file with the provided content.

Usage:
- This tool overwrites the existing file at the path. ALWAYS Read the file first if it exists, so you know what you are about to replace.
- Prefer Edit for changing existing files — Edit sends only the diff and is much harder to misuse. Use Write only for new files or genuine full rewrites.
- NEVER create documentation files (\`*.md\`, README, CHANGELOG) unless the user explicitly asks. Auto-generating docs annoys users and is rarely what they want.
- Avoid adding emojis to files unless the user explicitly asks.`,
  domain: 'environment',
  riskLevel: 'write',
  inputSchema: z.object({
    file_path: z.string().min(1),
    content: z.string(),
  }),
  suggestPermissionRules(input) {
    return suggestPathRules('Write', input.file_path)
  },
  async call(input, context) {
    try {
      const targetPath = resolveInputPath(context.runtime.workspaceRoot, input.file_path)
      await context.runtime.fs.writeFile(targetPath, input.content)
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
