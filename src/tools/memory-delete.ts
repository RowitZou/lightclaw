import { stat, unlink } from 'node:fs/promises'
import path from 'node:path'

import { z } from 'zod'

import { rebuildMemoryIndex } from '../memory/auto-memory.js'
import { joinAndAssertWithinMemoryDir, MemoryToolPathError } from '../memory/tool-path.js'
import { getMemoryDir } from '../state.js'
import { buildTool } from '../tool.js'

export const memoryDeleteTool = buildTool({
  name: 'MemoryDelete',
  internalOnly: true,
  description:
    'Internal autoDream tool: delete one memory markdown file under the current user memory directory.',
  domain: 'host',
  riskLevel: 'safe',
  inputSchema: z.object({
    path: z.string().min(1).describe('Relative file path under memoryDir.'),
  }),
  async call(input) {
    try {
      const memoryDir = getMemoryDir()
      const target = joinAndAssertWithinMemoryDir(memoryDir, input.path)
      let stats
      try {
        stats = await stat(target)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return { output: 'No-op (file did not exist)' }
        }
        throw error
      }

      if (stats.isDirectory()) {
        throw new MemoryToolPathError('cannot delete a directory; this tool only deletes files')
      }

      await unlink(target)
      await rebuildMemoryIndex(path.dirname(target))
      return {
        output: `Deleted ${input.path}`,
      }
    } catch (error) {
      return {
        output: error instanceof Error ? error.message : String(error),
        isError: true,
      }
    }
  },
})
