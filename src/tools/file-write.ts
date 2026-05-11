import path from 'node:path'

import { z } from 'zod'

import { suggestPathRules } from '../permission/suggestions.js'
import { buildTool } from '../tool.js'
import { hasPathBeenRead } from './read-dedup.js'

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
      // Soft Read-before-Write reminder: if the model never Read this path
      // (or any cache entry was evicted past the 256-entry LRU), prepend a
      // note. NOT a hard block — new-file Writes are legitimate. The
      // reminder is informational so the model can self-correct without
      // breaking flow. Hard enforcement requires distinguishing "new file"
      // from "missing Read", which needs filesystem stat; leave to V2.
      const readBefore = hasPathBeenRead(targetPath)
      await context.runtime.fs.writeFile(targetPath, input.content)
      const reminder = readBefore
        ? ''
        : `Note: ${targetPath} was not Read this session. If overwriting an existing file, prefer Read first to verify the current content.\n\n`
      return {
        output: `${reminder}Wrote ${Buffer.byteLength(input.content, 'utf8')} bytes to ${targetPath}`,
      }
    } catch (error) {
      return {
        output: error instanceof Error ? error.message : String(error),
        isError: true,
      }
    }
  },
})
