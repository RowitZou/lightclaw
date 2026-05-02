import path from 'node:path'

import { z } from 'zod'

import { getConfig } from '../config.js'
import { buildTool } from '../tool.js'

const REMINDER = 'REMINDER: Cite sources with Markdown links when answering.'
const DEFAULT_TIMEOUT_MS = 35_000

export const webSearchTool = buildTool({
  name: 'WebSearch',
  description: 'Search the web from the environment runtime. Returns search findings and source URLs.',
  domain: 'environment',
  // Network egress: the query string leaves the host (potentially leaking
  // sensitive keywords to the search vendor), so this is not "safe" in the
  // same sense as Read/Grep. Aligned with WebFetch (also 'execute') so
  // admins get a confirmation prompt for any outbound web access in
  // default mode.
  riskLevel: 'execute',
  concurrencySafe: true,
  inputSchema: z.object({
    query: z.string().min(2),
    allowed_domains: z.array(z.string()).optional(),
    blocked_domains: z.array(z.string()).optional(),
    max_results: z.number().int().min(1).max(20).optional(),
  }),
  async call(input, context) {
    const helper = path.join(context.runtime.helperRoot, 'websearch.py')
    const braveApiKey = getConfig().tools.webSearch.braveApiKey ?? ''
    const result = await context.runtime.exec({
      command: `python3 ${shellQuote(helper)}`,
      stdin: JSON.stringify({
        query: input.query,
        allowed_domains: input.allowed_domains ?? [],
        blocked_domains: input.blocked_domains ?? [],
        max_results: input.max_results ?? 10,
      }),
      env: {
        LIGHTCLAW_SEARCH_API_KEY: process.env.LIGHTCLAW_SEARCH_API_KEY ?? '',
        LIGHTCLAW_SEARCH_API_URL: process.env.LIGHTCLAW_SEARCH_API_URL ?? '',
        BRAVE_SEARCH_API_KEY: braveApiKey,
      },
      timeoutMs: DEFAULT_TIMEOUT_MS,
      abortSignal: context.abortSignal,
      maxBufferBytes: 512 * 1024,
    })

    if (result.exitCode !== 0) {
      return {
        output: `WebSearch failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`,
        isError: true,
      }
    }

    return {
      output: [result.stdout.trimEnd(), '', REMINDER].join('\n').trim(),
    }
  },
})

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
