import { z } from 'zod'

import { readMemoryFile, scanMemoryFiles } from '../memory/auto-memory.js'
import { getMemoryDir } from '../state.js'
import { buildTool } from '../tool.js'

export const memoryReadTool = buildTool({
  name: 'MemoryRead',
  description:
    'Read auto-memory files. Use action "list" to list files or "read" to inspect a specific memory file.',
  riskLevel: 'safe',
  inputSchema: z.object({
    action: z.enum(['list', 'read']),
    filename: z.string().min(1).optional(),
  }),
  async call(input) {
    try {
      const memoryDir = getMemoryDir()

      if (input.action === 'list') {
        const entries = await scanMemoryFiles(memoryDir)
        return {
          output:
            entries.length > 0
              ? entries
                  .map(
                    entry =>
                      `[${entry.type}] ${entry.filename}: ${entry.description}`,
                  )
                  .join('\n')
              : 'No memory files found.',
        }
      }

      if (!input.filename) {
        return {
          output: 'filename is required when action is "read".',
          isError: true,
        }
      }

      const content = await readMemoryFile(memoryDir, input.filename)
      return {
        output: content ?? `Memory file not found: ${input.filename}`,
        ...(content ? {} : { isError: true }),
      }
    } catch (error) {
      return {
        output: error instanceof Error ? error.message : String(error),
        isError: true,
      }
    }
  },
})
