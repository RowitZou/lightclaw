import path from 'node:path'

import { z } from 'zod'

import { buildTool } from '../tool.js'

const DEFAULT_MAX_BYTES = 200_000
const DEFAULT_TIMEOUT_MS = 35_000

export const webFetchTool = buildTool({
  name: 'WebFetch',
  description:
    'Fetch content from a URL and return it as Markdown. Supports HTML, plain text, Markdown, and JSON. Binary content is rejected.',
  domain: 'environment',
  riskLevel: 'execute',
  concurrencySafe: true,
  inputSchema: z.object({
    url: z.string().url(),
    maxBytes: z.number().int().min(1024).max(500_000).optional(),
    timeoutMs: z.number().int().min(1000).max(120_000).optional(),
  }),
  async call(input, context) {
    const maxBytes = input.maxBytes ?? 200_000
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const helper = path.join(context.runtime.helperRoot, 'webfetch.py')
    const result = await context.runtime.exec({
      command: `python3 ${shellQuote(helper)}`,
      stdin: JSON.stringify({
        url: input.url,
        max_bytes: maxBytes,
        timeout_seconds: Math.ceil(timeoutMs / 1000),
      }),
      timeoutMs,
      abortSignal: context.abortSignal,
      maxBufferBytes: Math.max(maxBytes + 16 * 1024, DEFAULT_MAX_BYTES),
    })

    if (result.exitCode !== 0) {
      return {
        output: `WebFetch failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`,
        isError: true,
      }
    }

    return {
      output: result.stdout.trimEnd(),
    }
  },
})

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
