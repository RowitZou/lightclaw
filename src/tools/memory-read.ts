import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

import { z } from 'zod'

import { recordMemoryWriteAudit, safeMemoryAuditUserId } from '../audit/memory-writes.js'
import { getMainRole } from '../agents/registry.js'
import type { Role } from '../agents/types.js'
import { memoryFreshnessText } from '../memory/aging.js'
import { normalizeMemoryFilename, scanMemoryFilesInDirs } from '../memory/auto-memory.js'
import {
  memoryPathWithinDir,
  relativeMemoryFilename,
  resolveReadableMemoryDirsForRole,
} from '../memory/scope.js'
import { getCurrentRole, getMemoryDir } from '../state.js'
import { buildTool } from '../tool.js'

export const memoryReadTool = buildTool({
  name: 'MemoryRead',
  whenToUse: `Read the full content of a memory file pointed to by the auto-memory index.`,
  shouldDefer: true,
  description: `Read auto-memory files for this user. Use action 'list' to enumerate or 'read' to inspect a specific file.

Reach for this when the user references stored preferences ("我之前让你..." / "you used to ..." / "remember when I asked you to ..."), project conventions, or facts that should persist across sessions. The auto-memory index (MEMORY.md) is already injected at session start; use this tool only when you need to read the full content of a specific memory file pointed to by the index.`,
  domain: 'host',
  riskLevel: 'safe',
  concurrencySafe: true,
  inputSchema: z.object({
    action: z.enum(['list', 'read']),
    filename: z.string().min(1).optional(),
  }),
  async call(input) {
    try {
      const memoryDir = getMemoryDir()
      const role = getCurrentRole() ?? getMainRole()
      const resolved = await resolveReadableMemoryDirsForRole(role, memoryDir)

      if (input.action === 'list') {
        const entries = await scanMemoryFilesInDirs(
          memoryDir,
          resolved.readableDirs,
          resolved.selfWriteDir,
        )
        return {
          output:
            entries.length > 0
              ? entries
                  .map(
                    entry =>
                      `[${entry.type}] ${entry.filename} (${entry.scope}): ${entry.description}`,
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

      const target = await resolveReadableMemoryFile(memoryDir, resolved.readableDirs, input.filename)
      if (!target) {
        await auditMemoryReadDenied(role, input.filename, memoryDir, 'Memory file is outside this role memory scope.')
        return {
          output: `Memory file is outside this role memory scope: ${input.filename}`,
          isError: true,
        }
      }

      const content = await readFile(target, 'utf8').catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return null
        }
        throw error
      })
      if (content) {
        let staleness = ''
        try {
          const stats = await stat(target)
          staleness = memoryFreshnessText(stats.mtimeMs)
        } catch {
          // mtime unavailable — fall through to plain content
        }
        const output = staleness
          ? `${content}\n\n<system-reminder>${staleness}</system-reminder>`
          : content
        return { output }
      }
      return {
        output: `Memory file not found: ${input.filename}`,
        isError: true,
      }
    } catch (error) {
      return {
        output: error instanceof Error ? error.message : String(error),
        isError: true,
      }
    }
  },
})

async function resolveReadableMemoryFile(
  memoryDir: string,
  readableDirs: string[],
  filename: string,
): Promise<string | null> {
  const raw = filename.trim()
  if (raw.length === 0 || path.isAbsolute(raw) || raw.includes('\\')) {
    return null
  }
  const parts = raw.split('/').filter(Boolean)
  if (parts.length === 0 || parts.some(part => part === '..' || part === '.')) {
    return null
  }

  const basename = normalizeMemoryFilename(parts.at(-1) ?? '')
  const scopedParts = [...parts.slice(0, -1), basename]
  if (scopedParts.length > 1) {
    const target = path.resolve(memoryDir, ...scopedParts)
    const root = path.resolve(memoryDir)
    return readableDirs.some(dir => {
      const resolvedDir = path.resolve(dir)
      if (resolvedDir === root) {
        return false
      }
      return memoryPathWithinDir(target, resolvedDir)
    })
      ? target
      : null
  }

  for (const dir of readableDirs) {
    const candidate = path.join(dir, basename)
    try {
      await stat(candidate)
      return candidate
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    }
  }

  return readableDirs[0] ? path.join(readableDirs[0], basename) : null
}

async function auditMemoryReadDenied(
  role: Role,
  filename: string,
  memoryDir: string,
  reason: string,
): Promise<void> {
  await recordMemoryWriteAudit({
    at: new Date().toISOString(),
    userId: safeMemoryAuditUserId(),
    role: role.agentType,
    filename,
    targetPath: relativeMemoryFilename(memoryDir, memoryDir, filename),
    status: 'denied',
    deniedReason: reason,
    operation: 'read',
  })
}
