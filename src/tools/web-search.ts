import path from 'node:path'

import { z } from 'zod'

import { getConfig } from '../config.js'
import { buildTool } from '../tool.js'

// Trailer appended to every WebSearch tool_result. Bug 7 in the 2026-05-10
// audit: prior trailer was just one cite-sources line, which let codex /
// gpt-5.x close the loop after a single search even when the snippet was a
// stale headline that didn't actually answer the question. The expanded
// guidance pushes the model toward a follow-up WebFetch when snippets are
// thin, anchors year terms to the system-prompt's Current date, and forces
// a Sources section so the user can audit upstream.
const REMINDER = [
  'REMINDERS:',
  '- Search snippets are short and may be stale, partial, or contain only headlines.',
  '- If a snippet does not directly answer the user\'s question (e.g. the user asked for a specific value but the snippet only shows headlines, or the snippet timestamp is older than today), follow up with WebFetch on the most authoritative link to retrieve the actual page content. Do NOT fabricate answers from partial snippets.',
  '- Use the current year (from the system prompt\'s Current date) in search queries; last-year terms pull stale results.',
  '- MANDATORY: After answering using WebSearch results, include a "Sources:" section listing the actual URLs as Markdown hyperlinks.',
].join('\n')
const DEFAULT_TIMEOUT_MS = 35_000

export const webSearchTool = buildTool({
  name: 'WebSearch',
  description: 'Search the web from the environment runtime. Returns search findings and source URLs. Snippets are short and may be stale or partial — when they do not directly answer the question, follow up with WebFetch on the top result. Always cite sources.',
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
