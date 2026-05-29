import { mkdir, rename, stat } from 'node:fs/promises'
import path from 'node:path'

import { z } from 'zod'

import { getMainRole } from '../agents/registry.js'
import { recordMemoryWriteAudit, safeMemoryAuditUserId } from '../audit/memory-writes.js'
import { rebuildMemoryIndex } from '../memory/auto-memory.js'
import { resolveSourceTier } from '../memory/scope.js'
import {
  assertNotMemoryIndex,
  joinAndAssertWithinMemoryDir,
  MemoryToolConflictError,
  MemoryToolNotFoundError,
  MemoryToolPathError,
} from '../memory/tool-path.js'
import { getCurrentRole, getMemoryDir } from '../state.js'
import { buildTool } from '../tool.js'

async function auditMove(input: {
  memoryDir: string
  fromRel: string
  toRel: string
  toAbs: string
  status: 'moved' | 'failed'
  deniedReason?: string
}): Promise<void> {
  const tier = resolveSourceTier(input.toAbs, input.memoryDir) ?? undefined
  await recordMemoryWriteAudit({
    at: new Date().toISOString(),
    userId: safeMemoryAuditUserId(),
    role: (getCurrentRole() ?? getMainRole()).agentType,
    filename: path.basename(input.toRel),
    targetPath: input.toAbs,
    status: input.status,
    operation: 'move',
    movedFrom: input.fromRel,
    ...(tier ? { sourceTier: tier } : {}),
    ...(input.deniedReason ? { deniedReason: input.deniedReason } : {}),
  })
}

export const memoryMoveTool = buildTool({
  name: 'MemoryMove',
  internalOnly: true,
  whenToUse: 'Relocate a memory file between tiers or paths while consolidating.',
  description:
    'Internal memoryCurator tool: move one memory markdown file to another path under the current user memory directory.',
  domain: 'host',
  riskLevel: 'safe',
  inputSchema: z.object({
    from: z.string().min(1).describe('Source relative path under memoryDir.'),
    to: z.string().min(1).describe('Destination relative path under memoryDir.'),
  }),
  async call(input) {
    const memoryDir = getMemoryDir()
    let from: string
    let to: string
    try {
      from = joinAndAssertWithinMemoryDir(memoryDir, input.from)
      to = joinAndAssertWithinMemoryDir(memoryDir, input.to)
      assertNotMemoryIndex(from)
      assertNotMemoryIndex(to)
    } catch (error) {
      // Path-resolution failures (../ escape, MEMORY.md) are not an on-disk
      // mutation; surface without an audit row, matching the other curator
      // tools' "don't audit pre-resolution throws" convention.
      return {
        output: error instanceof Error ? error.message : String(error),
        isError: true,
      }
    }

    const fromDir = path.dirname(from)
    const toDir = path.dirname(to)
    try {
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

      await auditMove({
        memoryDir,
        fromRel: input.from,
        toRel: input.to,
        toAbs: to,
        status: 'moved',
      })
      return {
        output: `Moved ${input.from} to ${input.to}`,
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      await auditMove({
        memoryDir,
        fromRel: input.from,
        toRel: input.to,
        toAbs: to,
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
