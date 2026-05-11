import { z } from 'zod'

import { buildTool } from '../tool.js'

export const globTool = buildTool({
  name: 'Glob',
  alwaysLoad: true,
  description: 'Find files by glob pattern.',
  domain: 'environment',
  riskLevel: 'safe',
  concurrencySafe: true,
  inputSchema: z.object({
    pattern: z.string().min(1),
    path: z.string().optional(),
  }),
  async call(input, context) {
    try {
      const matches = await context.runtime.fs.glob(input.pattern, {
        cwd: input.path ?? context.runtime.workspaceRoot,
        dot: true,
        onlyFiles: false,
      })
      return {
        output: matches.length > 0 ? matches.join('\n') : '[no files matched]',
      }
    } catch (error) {
      return {
        output: error instanceof Error ? error.message : String(error),
        isError: true,
      }
    }
  },
})
