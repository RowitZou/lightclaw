import { stat, unlink } from 'node:fs/promises'
import path from 'node:path'

import { z } from 'zod'

import { getMainRole } from '../agents/registry.js'
import { recordMemoryWriteAudit, safeMemoryAuditUserId } from '../audit/memory-writes.js'
import { rebuildMemoryIndex } from '../memory/auto-memory.js'
import { shouldBlockMemoryDelete } from '../memory/destructive-guard.js'
import { resolveSourceTier } from '../memory/scope.js'
import {
  assertNotMemoryIndex,
  joinAndAssertWithinMemoryDir,
  MemoryToolPathError,
} from '../memory/tool-path.js'
import { getCurrentRole, getMemoryDir } from '../state.js'
import { buildTool } from '../tool.js'

async function auditDelete(input: {
  memoryDir: string
  relPath: string
  targetPath: string
  status: 'deleted' | 'denied' | 'failed'
  deniedReason?: string
}): Promise<void> {
  const tier = resolveSourceTier(input.targetPath, input.memoryDir) ?? undefined
  await recordMemoryWriteAudit({
    at: new Date().toISOString(),
    userId: safeMemoryAuditUserId(),
    role: (getCurrentRole() ?? getMainRole()).agentType,
    filename: path.basename(input.relPath),
    targetPath: input.targetPath,
    status: input.status,
    operation: 'delete',
    ...(tier ? { sourceTier: tier } : {}),
    ...(input.deniedReason ? { deniedReason: input.deniedReason } : {}),
  })
}

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
    const memoryDir = getMemoryDir()
    let target: string
    try {
      target = joinAndAssertWithinMemoryDir(memoryDir, input.path)
      assertNotMemoryIndex(target)
    } catch (error) {
      // Path-resolution failures (../ escape, MEMORY.md) are unrelated to a
      // real on-disk mutation; surface the error without an audit row to
      // match MemoryWrite's "don't audit pre-resolution throws" convention.
      return {
        output: error instanceof Error ? error.message : String(error),
        isError: true,
      }
    }

    try {
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
        await auditDelete({
          memoryDir,
          relPath: input.path,
          targetPath: target,
          status: 'denied',
          deniedReason: `same-path MemoryWriteAt failed ${ageSec}s ago`,
        })
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
          // Nothing was deleted — no audit row (no mutation occurred).
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
      await auditDelete({
        memoryDir,
        relPath: input.path,
        targetPath: target,
        status: 'deleted',
      })
      return {
        output: `Deleted ${input.path}`,
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      await auditDelete({
        memoryDir,
        relPath: input.path,
        targetPath: target,
        status: 'failed',
        deniedReason: reason,
      })
      return {
        output: reason,
        isError: true,
      }
    }
  },
})
