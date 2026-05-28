import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { z } from 'zod'

import { getMainRole } from '../agents/registry.js'
import { recordMemoryWriteAudit, safeMemoryAuditUserId } from '../audit/memory-writes.js'
import {
  normalizeMemoryFilename,
  rebuildMemoryIndex,
  serializeFrontmatter,
} from '../memory/auto-memory.js'
import { recordMemoryWriteAtFailure } from '../memory/destructive-guard.js'
import { resolveSourceTier } from '../memory/scope.js'
import { assertNotMemoryIndex, joinAndAssertWithinMemoryDir } from '../memory/tool-path.js'
import { isMemoryType } from '../memory/types.js'
import { getCurrentRole, getMemoryDir } from '../state.js'
import { buildTool } from '../tool.js'

async function auditWriteAt(input: {
  memoryDir: string
  targetPath: string
  status: 'written' | 'denied' | 'failed'
  deniedReason?: string
}): Promise<void> {
  const tier = resolveSourceTier(input.targetPath, input.memoryDir) ?? undefined
  await recordMemoryWriteAudit({
    at: new Date().toISOString(),
    userId: safeMemoryAuditUserId(),
    role: (getCurrentRole() ?? getMainRole()).agentType,
    filename: path.basename(input.targetPath),
    targetPath: input.targetPath,
    status: input.status,
    operation: 'write-at',
    ...(tier ? { sourceTier: tier } : {}),
    ...(input.deniedReason ? { deniedReason: input.deniedReason } : {}),
  })
}

export const memoryWriteAtTool = buildTool({
  name: 'MemoryWriteAt',
  internalOnly: true,
  description:
    'Internal memoryCurator tool: write a memory markdown file at an explicit path under the current user memory directory.',
  domain: 'host',
  riskLevel: 'safe',
  inputSchema: z.object({
    path: z
      .string()
      .min(1)
      .describe("Relative path under memoryDir, e.g. '_shared/2026-05-16-topic-by-web.md'."),
    content: z.string().min(10).describe('Markdown body for the memory.'),
    type: z.enum(['user', 'feedback', 'project', 'reference']),
    description: z.string().min(5).max(150),
  }),
  async call(input) {
    // Resolve the absolute target path FIRST so any subsequent failure
    // (schema, validation, fs error) can register a same-target failure
    // for the destructive guard. Resolution itself can throw on
    // `../`-escapes / bad filenames — those are unrelated to the
    // destructive-pattern race so we let them fall through to the normal
    // error path without recording.
    const memoryDir = getMemoryDir()
    let target: string
    try {
      const rawTarget = joinAndAssertWithinMemoryDir(memoryDir, input.path)
      assertNotMemoryIndex(rawTarget)
      const targetDir = path.dirname(rawTarget)
      target = path.join(targetDir, normalizeMemoryFilename(path.basename(rawTarget)))
      joinAndAssertWithinMemoryDir(memoryDir, path.relative(memoryDir, target))
      assertNotMemoryIndex(target)
    } catch (error) {
      return {
        output: error instanceof Error ? error.message : String(error),
        isError: true,
      }
    }

    try {
      if (!isMemoryType(input.type)) {
        const msg = `Unsupported memory type: ${input.type}`
        recordMemoryWriteAtFailure(memoryDir, target)
        process.stderr.write(
          `[memory-write-at] validation failed memoryDir=${memoryDir} path=${input.path} reason=${msg}\n`,
        )
        await auditWriteAt({ memoryDir, targetPath: target, status: 'denied', deniedReason: msg })
        return { output: msg, isError: true }
      }

      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(
        target,
        serializeFrontmatter(
          {
            type: input.type,
            description: input.description.trim(),
          },
          input.content.trim(),
        ),
        'utf8',
      )
      await rebuildMemoryIndex(path.dirname(target))

      await auditWriteAt({ memoryDir, targetPath: target, status: 'written' })
      return {
        output: `Wrote to ${path.relative(memoryDir, target)}`,
      }
    } catch (error) {
      recordMemoryWriteAtFailure(memoryDir, target)
      const reason = error instanceof Error ? error.message : String(error)
      process.stderr.write(
        `[memory-write-at] validation failed memoryDir=${memoryDir} path=${input.path} reason=${reason}\n`,
      )
      await auditWriteAt({ memoryDir, targetPath: target, status: 'failed', deniedReason: reason })
      return {
        output: reason,
        isError: true,
      }
    }
  },
})
