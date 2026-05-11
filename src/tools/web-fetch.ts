import path from 'node:path'

import { z } from 'zod'

import { summarizeWebFetch } from '../api.js'
import { suggestWebFetchRules } from '../permission/suggestions.js'
import { buildTool } from '../tool.js'
import { isPreapprovedUrl } from './web-fetch-preapproved.js'

const DEFAULT_MAX_BYTES = 50_000     // helper exec output cap (schema default); admin can raise via input.maxBytes up to MAX_BYTES_HARD_CAP
const MAX_BYTES_HARD_CAP = 100_000   // matches Claude Code MAX_MARKDOWN_LENGTH order of magnitude — admin cannot request more
const DEFAULT_TIMEOUT_MS = 35_000
const MAX_MARKDOWN_LENGTH = 100_000  // chars; sub-LLM-path truncation before Haiku-equivalent call to avoid prompt-too-long
const MAX_RAW_LENGTH = 50_000        // chars; no-prompt-path truncation. Past this, the raw return is sliced + a marker hint nudges toward the prompt/maxBytes escape hatches.

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

Without a \`prompt\` field: returns the page as Markdown (HTML/text shaped responses) or downloads binary to .lightclaw/downloads/ (PDF/image/archive/office). For pages longer than ${MAX_RAW_LENGTH} chars the raw output is truncated with a marker — pass \`prompt\` for a focused sub-LLM summary of the full page, or raise \`maxBytes\` (up to ${MAX_BYTES_HARD_CAP}) to pull more bytes from the helper.

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
    maxBytes: z.number().int().min(1024).max(MAX_BYTES_HARD_CAP).optional(),
    timeoutMs: z.number().int().min(1000).max(120_000).optional(),
  }),
  suggestPermissionRules(input) {
    return suggestWebFetchRules(input.url)
  },
  async call(input, context) {
    const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES
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
      maxBufferBytes: maxBytes + 16 * 1024,
    })

    if (result.exitCode !== 0) {
      return {
        output: `WebFetch failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`,
        isError: true,
      }
    }

    const rawMarkdown = result.stdout.trimEnd()

    // No prompt → return raw, but truncate past MAX_RAW_LENGTH chars to keep
    // a single fetch from dominating main-model context. The marker tells the
    // model the two escape hatches: pass `prompt` for sub-LLM summarize of
    // the full content, or raise `maxBytes` (up to MAX_BYTES_HARD_CAP) to
    // pull more bytes from the helper. Mirrors Claude Code's MAX_MARKDOWN_LENGTH
    // strategy but in the raw path (we deliberately lower the threshold from
    // sub-LLM's 100K to 50K because raw text costs the main model directly
    // rather than via summary).
    if (!input.prompt) {
      if (rawMarkdown.length > MAX_RAW_LENGTH) {
        return {
          output:
            rawMarkdown.slice(0, MAX_RAW_LENGTH) +
            `\n\n[Page is ${rawMarkdown.length} chars, truncated to ${MAX_RAW_LENGTH}. ` +
            `To get a focused answer on the full page, pass \`prompt\` to use the sub-LLM summarize path. ` +
            `To raise the helper byte cap, pass \`maxBytes\` up to ${MAX_BYTES_HARD_CAP}.]`,
        }
      }
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
