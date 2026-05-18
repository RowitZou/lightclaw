import path from 'node:path'

import { z } from 'zod'

import { recordMemoryWriteAudit, safeMemoryAuditUserId } from '../audit/memory-writes.js'
import { getMainRole } from '../agents/registry.js'
import { normalizeMemoryFilename, writeMemoryFile } from '../memory/auto-memory.js'
import { memoryPathWithinDir, resolveMemoryDirsForRole, resolveSourceTier } from '../memory/scope.js'
import { isMemoryType } from '../memory/types.js'
import { getCurrentRole, getMemoryDir } from '../state.js'
import { buildTool } from '../tool.js'

export const memoryWriteTool = buildTool({
  name: 'MemoryWrite',
  shouldDefer: true,
  description: `Create or update a persistent auto-memory entry for this user. The framework decides where the entry lands based on your role; you do not pass a path.

Use when the user explicitly says "记住" / "remember this" / "from now on", OR when the user has corrected your approach in a way that should apply to future sessions, OR when you've learned a non-obvious project fact / convention.

Choose \`type\` carefully:
- \`user\`: who the user is, their role, what they're working on long-term
- \`feedback\`: corrections / preferences ("do X, never Y"). Always include Why: and How to apply: sections.
- \`project\`: project-specific conventions, dates, in-progress work. Always include Why: and How to apply: sections.
- \`reference\`: pointers to external systems (Linear projects, Slack channels, Grafana dashboards).

\`filename\` should be concise kebab/snake-case. \`description\` is one line used in MEMORY.md and recall — be specific so future you can decide relevance.`,
  domain: 'host',
  riskLevel: 'safe',
  inputSchema: z.object({
    filename: z
      .string()
      .min(1)
      .describe('Markdown filename for the memory. Use a concise kebab/snake name; .md is optional.'),
    type: z
      .enum(['user', 'feedback', 'project', 'reference'])
      .describe('Memory category: user preference, feedback/correction, project convention, or stable reference.'),
    description: z
      .string()
      .min(5)
      .max(150)
      .describe('One-line summary used in MEMORY.md and recall selection.'),
    content: z
      .string()
      .min(10)
      .describe('Markdown body. For feedback/project memories include Why: and How to apply: sections.'),
  }),
  async call(input) {
    const role = getCurrentRole() ?? getMainRole()
    const memoryDir = getMemoryDir()
    const resolved = resolveMemoryDirsForRole(role, memoryDir)
    const targetPath = safeTargetPath(resolved.selfWriteDir, input.filename)
    const sourceTier = resolveSourceTier(targetPath, memoryDir) ?? undefined
    try {
      if (!memoryPathWithinDir(targetPath, resolved.selfWriteDir)) {
        throw new Error('Memory filename must stay within the role memory directory.')
      }

      if (!isMemoryType(input.type)) {
        await auditMemoryWrite({
          role: role.agentType,
          filename: input.filename,
          targetPath,
          status: 'denied',
          deniedReason: `Unsupported memory type: ${input.type}`,
          sourceTier,
        })
        return {
          output: `Unsupported memory type: ${input.type}`,
          isError: true,
        }
      }

      await writeMemoryFile(resolved.selfWriteDir, {
        filename: input.filename,
        type: input.type,
        description: input.description.trim(),
        content: input.content.trim(),
        mtimeMs: Date.now(),
      })
      await auditMemoryWrite({
        role: role.agentType,
        filename: input.filename,
        targetPath,
        status: 'written',
        sourceTier,
      })

      return {
        output: `Saved memory ${input.filename}`,
      }
    } catch (error) {
      await auditMemoryWrite({
        role: role.agentType,
        filename: input.filename,
        targetPath,
        status: 'denied',
        deniedReason: error instanceof Error ? error.message : String(error),
        sourceTier,
      })
      return {
        output: error instanceof Error ? error.message : String(error),
        isError: true,
      }
    }
  },
})

async function auditMemoryWrite(input: {
  role: string
  filename: string
  targetPath: string
  status: 'written' | 'denied'
  deniedReason?: string
  sourceTier?: 'L1' | 'L2' | 'L3'
}): Promise<void> {
  await recordMemoryWriteAudit({
    at: new Date().toISOString(),
    userId: safeMemoryAuditUserId(),
    role: input.role,
    filename: input.filename,
    targetPath: input.targetPath,
    status: input.status,
    operation: 'write',
    ...(input.sourceTier ? { sourceTier: input.sourceTier } : {}),
    ...(input.deniedReason ? { deniedReason: input.deniedReason } : {}),
  })
}

function safeTargetPath(memoryDir: string, filename: string): string {
  try {
    return path.join(memoryDir, normalizeMemoryFilename(filename))
  } catch {
    return memoryDir
  }
}
