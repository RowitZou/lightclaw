import path from 'node:path'

import { z } from 'zod'

import { summarizeWebFetch } from '../api.js'
import { suggestWebFetchRules } from '../permission/suggestions.js'
import { buildTool } from '../tool.js'
import { isPreapprovedUrl } from './web-fetch-preapproved.js'

const DEFAULT_MAX_BYTES = 200_000
const DEFAULT_TIMEOUT_MS = 35_000
const MAX_MARKDOWN_LENGTH = 100_000  // chars; matches Claude Code. Truncate before sub-LLM to avoid prompt-too-long.

type SummarizeFn = (input: {
  url: string
  prompt: string
  markdown: string
  signal: AbortSignal
}) => Promise<string>

let summarizeFn: SummarizeFn = summarizeWebFetch

/** Test-only escape hatch — DO NOT call from production code. Pass `null` to
 *  restore the default `summarizeWebFetch` implementation. */
export function _setWebFetchSummarizerForTests(fn: SummarizeFn | null): void {
  summarizeFn = fn ?? summarizeWebFetch
}

export const webFetchTool = buildTool({
  name: 'WebFetch',
  description: `Fetch content from a URL.

Without a \`prompt\` field: returns the page as Markdown (HTML/text shaped responses) or downloads binary to .lightclaw/downloads/ (PDF/image/archive/office). For long documentation pages this can fill main-model context — pass \`prompt\` when you want a focused answer instead of the full page.

With a \`prompt\` field: a sub-LLM reads the fetched markdown and answers your prompt. The sub-LLM has no tool access; it only summarizes / extracts from the page. Use for "what does this page say about X" / "extract the API endpoints from this docs page" / "is there a section on Y in this README". Saves you reading the whole page.

For preapproved domains (Python/Node/TS/React/Next/FastAPI/MDN/Anthropic/OpenAI/Go docs) with markdown content under ${MAX_MARKDOWN_LENGTH} chars, the prompt is ignored and raw markdown is returned — these docs are well-structured and the sub-LLM would just paraphrase.

For GitHub URLs, prefer Bash with \`gh\` (e.g. \`gh pr view 123 --json title,body\`) — returns structured JSON, smaller and easier to parse than the HTML page.

When a URL redirects to a different host, follow up with a new WebFetch on the redirect target.`,
  domain: 'environment',
  riskLevel: 'execute',
  concurrencySafe: true,
  inputSchema: z.object({
    url: z.string().url(),
    prompt: z.string().min(1).optional(),
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

    const rawMarkdown = result.stdout.trimEnd()

    // No prompt → return raw (current behavior, preserved for back-compat).
    if (!input.prompt) {
      return { output: rawMarkdown }
    }

    // Short-circuit: preapproved domain + content fits unsummarized.
    if (isPreapprovedUrl(input.url) && rawMarkdown.length < MAX_MARKDOWN_LENGTH) {
      return {
        output:
          `[Preapproved domain — sub-LLM summarize skipped, returning raw markdown]\n\n` +
          rawMarkdown,
      }
    }

    // Truncate before sub-LLM to avoid "prompt too long" errors.
    const truncated =
      rawMarkdown.length > MAX_MARKDOWN_LENGTH
        ? rawMarkdown.slice(0, MAX_MARKDOWN_LENGTH) + '\n\n[Content truncated due to length...]'
        : rawMarkdown

    try {
      const summary = await summarizeFn({
        url: input.url,
        prompt: input.prompt,
        markdown: truncated,
        signal: context.abortSignal,
      })
      if (!summary.trim()) {
        // Rare: sub-LLM produced no text events at all. Fall back to raw so
        // the main agent gets something useful instead of an empty result.
        return {
          output: `[WebFetch summarize returned empty — returning raw markdown]\n\n${rawMarkdown}`,
        }
      }
      return { output: summary }
    } catch (error) {
      // Sub-LLM failure: fall back to raw markdown with a note so the main
      // model knows the prompt didn't take effect. Don't swallow — surface
      // the failure reason for admin grep.
      const reason = error instanceof Error ? error.message : String(error)
      process.stderr.write(`[web-fetch] summarize failed: ${reason}\n`)
      return {
        output:
          `[WebFetch summarize failed: ${reason} — returning raw markdown]\n\n` +
          rawMarkdown,
      }
    }
  },
})

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
