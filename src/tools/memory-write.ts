import { z } from 'zod'

import { writeMemoryFile } from '../memory/auto-memory.js'
import { isMemoryType } from '../memory/types.js'
import { getMemoryDir } from '../state.js'
import { buildTool } from '../tool.js'

export const memoryWriteTool = buildTool({
  name: 'MemoryWrite',
  description:
    'Create or update a persistent auto-memory entry with validated metadata and content.',
  riskLevel: 'write',
  inputSchema: z.object({
    filename: z.string().min(1),
    type: z.enum(['user', 'feedback', 'project', 'reference']),
    description: z.string().min(1),
    content: z.string().min(1),
  }),
  async call(input) {
    try {
      if (!isMemoryType(input.type)) {
        return {
          output: `Unsupported memory type: ${input.type}`,
          isError: true,
        }
      }

      const memoryDir = getMemoryDir()
      await writeMemoryFile(memoryDir, {
        filename: input.filename,
        type: input.type,
        description: input.description.trim(),
        content: input.content.trim(),
      })

      return {
        output: `Saved memory ${input.filename}`,
      }
    } catch (error) {
      return {
        output: error instanceof Error ? error.message : String(error),
        isError: true,
      }
    }
  },
})
