import path from 'node:path'

import { z } from 'zod'

import { suggestWebFetchRules } from '../permission/suggestions.js'
import { buildTool } from '../tool.js'

const DEFAULT_MAX_BYTES = 200_000
const DEFAULT_TIMEOUT_MS = 35_000

export const webFetchTool = buildTool({
  name: 'WebFetch',
  description:
    'Fetch content from a URL. Text-shaped responses (HTML, plain text, Markdown, JSON, XML) are returned as Markdown. Binary responses (PDF, images, archives, office docs, ...) are downloaded to .lightclaw/downloads/ inside the workspace and the saved path is returned for follow-up tools to consume.',
  domain: 'environment',
  riskLevel: 'execute',
  concurrencySafe: true,
  inputSchema: z.object({
    url: z.string().url(),
    maxBytes: z.number().int().min(1024).max(500_000).optional(),
    timeoutMs: z.number().int().min(1000).max(120_000).optional(),
  }),
  suggestPermissionRules(input) {
    return suggestWebFetchRules(input.url)
  },
  async call(input, context) {
    const maxBytes = input.maxBytes ?? 200_000
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const helper = path.join(context.runtime.helperRoot, 'webfetch.py')
    // workspaceRoot is in the runtime's own path view (LocalRuntime: host
    // path, Docker/Rlaunch: /workspace). Posix join is correct in both —
    // /workspace/.lightclaw/downloads on the sandbox side, /abs/host/...
    // on LocalRuntime which is also already posix on Linux.
    const downloadDir = path.posix.join(
      context.runtime.workspaceRoot.replace(/\\/g, '/'),
      '.lightclaw',
      'downloads',
    )
    const result = await context.runtime.exec({
      command: `python3 ${shellQuote(helper)}`,
      stdin: JSON.stringify({
        url: input.url,
        max_bytes: maxBytes,
        timeout_seconds: Math.ceil(timeoutMs / 1000),
        download_dir: downloadDir,
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
