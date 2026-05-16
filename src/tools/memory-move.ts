import { mkdir, rename, stat } from 'node:fs/promises'
import path from 'node:path'

import { z } from 'zod'

import { rebuildMemoryIndex } from '../memory/auto-memory.js'
import {
  joinAndAssertWithinMemoryDir,
  MemoryToolConflictError,
  MemoryToolNotFoundError,
  MemoryToolPathError,
} from '../memory/tool-path.js'
import { getMemoryDir } from '../state.js'
import { buildTool } from '../tool.js'

export const memoryMoveTool = buildTool({
  name: 'MemoryMove',
  internalOnly: true,
  description:
    'Internal autoDream tool: move one memory markdown file to another path under the current user memory directory.',
  domain: 'host',
  riskLevel: 'safe',
  inputSchema: z.object({
    from: z.string().min(1).describe('Source relative path under memoryDir.'),
    to: z.string().min(1).describe('Destination relative path under memoryDir.'),
  }),
  async call(input) {
    try {
      const memoryDir = getMemoryDir()
      const from = joinAndAssertWithinMemoryDir(memoryDir, input.from)
      const to = joinAndAssertWithinMemoryDir(memoryDir, input.to)
      const fromDir = path.dirname(from)
      const toDir = path.dirname(to)
      let fromStats

      try {
        fromStats = await stat(from)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new MemoryToolNotFoundError('source file does not exist')
        }
        throw error
      }
      if (fromStats.isDirectory()) {
        throw new MemoryToolPathError('source must be a file')
      }

      try {
        await stat(to)
        throw new MemoryToolConflictError('destination already exists')
      } catch (error) {
        if (error instanceof MemoryToolConflictError) {
          throw error
        }
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error
        }
      }

      await mkdir(toDir, { recursive: true })
      await rename(from, to)
      await Promise.all([
        rebuildMemoryIndex(fromDir),
        fromDir === toDir ? Promise.resolve() : rebuildMemoryIndex(toDir),
      ])

      return {
        output: `Moved ${input.from} to ${input.to}`,
      }
    } catch (error) {
      return {
        output: error instanceof Error ? error.message : String(error),
        isError: true,
      }
    }
  },
})
