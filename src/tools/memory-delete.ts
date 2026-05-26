import { stat, unlink } from 'node:fs/promises'
import path from 'node:path'

import { z } from 'zod'

import { rebuildMemoryIndex } from '../memory/auto-memory.js'
import { shouldBlockMemoryDelete } from '../memory/destructive-guard.js'
import {
  assertNotMemoryIndex,
  joinAndAssertWithinMemoryDir,
  MemoryToolPathError,
} from '../memory/tool-path.js'
import { getMemoryDir } from '../state.js'
import { buildTool } from '../tool.js'

export const memoryDeleteTool = buildTool({
  name: 'MemoryDelete',
  internalOnly: true,
  description:
    'Internal memoryCurator tool: delete one memory markdown file under the current user memory directory.',
  domain: 'host',
  riskLevel: 'safe',
  inputSchema: z.object({
    path: z.string().min(1).describe('Relative file path under memoryDir.'),
  }),
  async call(input) {
    try {
      const memoryDir = getMemoryDir()
      const target = joinAndAssertWithinMemoryDir(memoryDir, input.path)
      assertNotMemoryIndex(target)

      // Same-target destructive guard: if a MemoryWriteAt for this path
      // failed recently, refuse the delete. Without this, a dispatched
      // curator that emits `MemoryWriteAt({path:X}) + MemoryDelete({path:X})`
      // in one batch silently loses the prior on-disk file when the write
      // fails validation. See `src/memory/destructive-guard.ts`.
      const block = shouldBlockMemoryDelete(memoryDir, target)
      if (block.blocked) {
        const ageSec = Math.max(1, Math.round((block.ageMs ?? 0) / 1000))
        process.stderr.write(
          `[memory-delete] refused memoryDir=${memoryDir} path=${input.path} reason=same-path MemoryWriteAt failed ${ageSec}s ago\n`,
        )
        return {
          output:
            `Refusing to delete ${input.path}: a MemoryWriteAt for the same path failed ` +
            `${ageSec}s ago. Deleting now would drop the still-present prior version. Retry the ` +
            `MemoryWriteAt (fix the validation error first); once it returns is_error:false, the ` +
            `delete becomes safe.`,
          isError: true,
        }
      }

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
      process.stderr.write(
        `[memory-delete] deleted memoryDir=${memoryDir} path=${input.path}\n`,
      )
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
