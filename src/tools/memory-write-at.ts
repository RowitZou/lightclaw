import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { z } from 'zod'

import {
  normalizeMemoryFilename,
  rebuildMemoryIndex,
  serializeFrontmatter,
} from '../memory/auto-memory.js'
import { assertNotMemoryIndex, joinAndAssertWithinMemoryDir } from '../memory/tool-path.js'
import { isMemoryType } from '../memory/types.js'
import { getMemoryDir } from '../state.js'
import { buildTool } from '../tool.js'

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
    try {
      if (!isMemoryType(input.type)) {
        return {
          output: `Unsupported memory type: ${input.type}`,
          isError: true,
        }
      }

      const memoryDir = getMemoryDir()
      const rawTarget = joinAndAssertWithinMemoryDir(memoryDir, input.path)
      assertNotMemoryIndex(rawTarget)
      const targetDir = path.dirname(rawTarget)
      const target = path.join(targetDir, normalizeMemoryFilename(path.basename(rawTarget)))
      joinAndAssertWithinMemoryDir(memoryDir, path.relative(memoryDir, target))
      assertNotMemoryIndex(target)

      await mkdir(targetDir, { recursive: true })
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
      await rebuildMemoryIndex(targetDir)

      return {
        output: `Wrote to ${path.relative(memoryDir, target)}`,
      }
    } catch (error) {
      return {
        output: error instanceof Error ? error.message : String(error),
        isError: true,
      }
    }
  },
})
