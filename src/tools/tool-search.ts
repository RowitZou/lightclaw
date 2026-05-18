import { z } from 'zod'

import { matchToolSearchQuery } from './tool-search-match.js'
import type { Tool, ToolCallResult } from '../tool.js'
import type { UserToolResultBlock } from '../types.js'

const ToolSearchInputSchema = z.object({
  query: z.string().min(1).describe(
    'Use select:Name1,Name2 for exact tool names, or keyword search such as "github file" / "+slack send".',
  ),
  max_results: z.number().int().min(1).max(50).optional().describe(
    'Maximum keyword-search matches to return. Defaults to 5. Ignored for select: queries.',
  ),
})

type ToolSearchInput = z.infer<typeof ToolSearchInputSchema>

export type ToolSearchOutput = {
  matches: string[]
  query: string
  total_deferred_tools: number
}

export const toolSearchTool: Tool<ToolSearchInput, ToolSearchOutput> = {
  name: 'ToolSearch',
  whenToUse: 'Load the schemas of deferred tools by exact name or keyword search.',
  description:
    'Search for deferred tool schemas by exact name or keyword. Tools listed only in deferred-tool reminders must be loaded with ToolSearch before they can be called.',
  source: 'builtin',
  domain: 'host',
  riskLevel: 'safe',
  alwaysLoad: true,
  inputSchema: ToolSearchInputSchema,
  async call(input, context): Promise<ToolCallResult<ToolSearchOutput>> {
    const deferredTools = context.deferredTools ?? []
    const result = matchToolSearchQuery(input.query, deferredTools, input.max_results ?? 5)
    for (const name of result.matches) {
      context.discoverTool?.(name)
    }
    return {
      output: {
        matches: result.matches,
        query: input.query,
        total_deferred_tools: deferredTools.length,
      },
    }
  },
  formatResult(output, toolUseId): UserToolResultBlock {
    const lines = [
      `ToolSearch found ${output.matches.length} match(es) for query "${output.query}".`,
    ]
    if (output.matches.length > 0) {
      for (const name of output.matches) {
        lines.push(`- ${name}`)
      }
      lines.push('')
      lines.push('These tool schemas are available on the next turn.')
    } else {
      lines.push(`No deferred tools matched. ${output.total_deferred_tools} deferred tool(s) are available.`)
    }
    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: lines.join('\n'),
    }
  },
}
