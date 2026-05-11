import { z } from 'zod'

import { writeMemoryFile } from '../memory/auto-memory.js'
import { isMemoryType } from '../memory/types.js'
import { getMemoryDir } from '../state.js'
import { buildTool } from '../tool.js'

export const memoryWriteTool = buildTool({
  name: 'MemoryWrite',
  shouldDefer: true,
  description: `Create or update a persistent auto-memory entry for this user.

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
        mtimeMs: Date.now(),
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
