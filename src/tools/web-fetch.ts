import path from 'node:path'

import { z } from 'zod'

import { summarizeWebFetch } from '../api.js'
import { getConfig } from '../config.js'
import { suggestWebFetchRules } from '../permission/suggestions.js'
import { buildTool } from '../tool.js'
import {
  cachedFetchAgeSeconds,
  getCachedFetch,
  setCachedFetch,
} from './web-fetch-cache.js'
import { textBodyToMarkdown } from './web-fetch-extract.js'
import { deriveFilename, isBinaryContentType } from './web-fetch-filename.js'
import { daemonFetchUrl } from './web-fetch-http.js'
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
  shouldDefer: true,
  description: `Fetch content from a URL.

Without a \`prompt\` field: returns the page as Markdown (HTML/text shaped responses) or downloads binary to .lightclaw/downloads/ (PDF/image/archive/office). For pages longer than ${MAX_RAW_LENGTH} chars the raw output is truncated with a marker — raise \`maxBytes\` (up to ${MAX_BYTES_HARD_CAP}) to pull more bytes from the helper.

With a \`prompt\` field: a sub-LLM reads the fetched markdown and answers your prompt. The sub-LLM has no tool access; it only summarizes / extracts from the page. Use for "what does this page say about X" / "extract the API endpoints from this docs page" / "is there a section on Y in this README". Caveat: the sub-LLM sees the same helper output the no-prompt path returns, so it can still miss content past the byte cap — if anything past the cap matters, fetch without \`prompt\` (raise \`maxBytes\` if needed) and read it yourself.

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
    // Cache lookup before any expensive work (HTTP fetch + sub-LLM). 15-min
    // TTL handles "fetch same docs page repeatedly in the same session"
    // without re-downloading or re-paying sub-LLM cost. Transparent return —
    // no marker so the main model treats cached output as live fetch.
    // Errors are not cached, so a previous failed fetch never poisons the
    // next attempt.
    const cached = getCachedFetch(input.url, input.prompt)
    if (cached !== undefined) {
      const ageSec = cachedFetchAgeSeconds(input.url, input.prompt)
      process.stderr.write(
        `[web-fetch] cache hit (age ${ageSec ?? '?'}s) url=${input.url}\n`,
      )
      return { output: cached }
    }
    const returnAndCache = (output: string): { output: string } => {
      setCachedFetch(input.url, input.prompt, output)
      return { output }
    }

    const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS

    // Phase 34: daemon-side fetch + extract replaces the Python helper
    // exec'd into the sandbox. workspaceRoot is in the runtime's own path
    // view (LocalRuntime: host path, Docker/Rlaunch: /workspace); we hand
    // the binary path to runtime.fs.writeFile which handles the
    // host↔worker translation in the layered DataPlane (Phase 33).
    const downloadDir = path.posix.join(
      context.runtime.workspaceRoot.replace(/\\/g, '/'),
      '.lightclaw',
      'downloads',
    )

    let rawMarkdown: string
    try {
      const fetched = await daemonFetchUrl(
        input.url,
        context.abortSignal,
        timeoutMs,
      )
      if (isBinaryContentType(fetched.contentType)) {
        // Binary path: persist raw bytes to download dir via daemon ↔ worker
        // fs bridge; report the path on stdout so the agent can Read it.
        // maxBytes is the cap on the persisted file size; oversized
        // downloads are written truncated with a flag in the header
        // (mirrors the Python helper's behavior post-PR #2).
        const truncated = fetched.bytes.length > maxBytes
        const bytesOut = truncated
          ? fetched.bytes.subarray(0, maxBytes)
          : fetched.bytes
        const filename = deriveFilename(
          fetched.finalUrl,
          fetched.contentType.toLowerCase(),
        )
        const filepath = path.posix.join(downloadDir, filename)
        await context.runtime.fs.writeFile(filepath, bytesOut)
        rawMarkdown = formatBinaryResponse({
          url: fetched.finalUrl,
          status: fetched.status,
          contentType: fetched.contentType,
          bytes: bytesOut.length,
          truncated,
          filepath,
        })
      } else {
        // Text path: utf-8 decode the full body, run turndown / JSON
        // pretty-print / strip according to content-type, then cap the
        // extracted body at maxBytes UTF-8 bytes (matches the helper's
        // post-extraction truncation in PR #2 — see webfetch.py:362-374
        // for the original byte-level slicing logic).
        const text = fetched.bytes.toString('utf-8')
        const body = textBodyToMarkdown(text, fetched.contentType)
        const bodyEncoded = Buffer.from(body, 'utf-8')
        const bodyTruncated = bodyEncoded.length > maxBytes
        const finalBody = bodyTruncated
          ? bodyEncoded.subarray(0, maxBytes).toString('utf-8').replace(/\s+$/, '')
          : body
        const reportedBytes = bodyTruncated
          ? Buffer.byteLength(finalBody, 'utf-8')
          : bodyEncoded.length
        rawMarkdown = formatTextResponse({
          url: fetched.finalUrl,
          status: fetched.status,
          contentType: fetched.contentType,
          bytes: reportedBytes,
          truncated: bodyTruncated,
          body: finalBody,
        })
      }
    } catch (err) {
      // Mirror the Python helper's stderr envelope: `fetch failed: <msg>`
      // wrapped in the WebFetch tool's `WebFetch failed (exit 1): ...`
      // shell. The error type (AxiosError / TimeoutError / DOMException
      // from abort) is included in the message so admin grep distinguishes
      // 4xx HTTP from network-level failures.
      const reason = err instanceof Error ? err.message : String(err)
      return {
        output: `WebFetch failed (exit 1): fetch failed: ${reason}`,
        isError: true,
      }
    }

    // No prompt → return raw, but truncate past MAX_RAW_LENGTH chars to keep
    // a single fetch from dominating main-model context. The marker tells the
    // model the escape hatch: raise `maxBytes` (up to MAX_BYTES_HARD_CAP) to
    // pull more bytes from the helper. Mirrors Claude Code's MAX_MARKDOWN_LENGTH
    // strategy but in the raw path (we deliberately lower the threshold from
    // sub-LLM's 100K to 50K because raw text costs the main model directly
    // rather than via summary). The sub-LLM `prompt` path is NOT suggested as
    // an "escape hatch" here — it sees the same helper output, so the byte cap
    // is the actual constraint to lift.
    if (!input.prompt) {
      if (rawMarkdown.length > MAX_RAW_LENGTH) {
        return returnAndCache(
          rawMarkdown.slice(0, MAX_RAW_LENGTH) +
            `\n\n[Page is ${rawMarkdown.length} chars, truncated to ${MAX_RAW_LENGTH}. ` +
            `To raise the helper byte cap, pass \`maxBytes\` up to ${MAX_BYTES_HARD_CAP}.]`,
        )
      }
      return returnAndCache(rawMarkdown)
    }

    // Short-circuit: preapproved domain + content fits unsummarized.
    // Admin extras (config.tools.webFetch.preapprovedDomains) are merged with
    // the built-in baseline list; getConfig() is cheap (cached) so reading
    // per-call is fine.
    const extras = getConfig().tools.webFetch?.preapprovedDomains ?? []
    if (isPreapprovedUrl(input.url, extras) && rawMarkdown.length < MAX_MARKDOWN_LENGTH) {
      return returnAndCache(
        `[Preapproved domain — sub-LLM summarize skipped, returning raw markdown]\n\n` +
          rawMarkdown,
      )
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
        return returnAndCache(
          `[WebFetch summarize returned empty — returning raw markdown]\n\n${rawMarkdown}`,
        )
      }
      return returnAndCache(summary)
    } catch (error) {
      // Sub-LLM failure: fall back to raw markdown with a note so the main
      // model knows the prompt didn't take effect. Don't swallow — surface
      // the failure reason for admin grep. Do NOT cache fallback responses —
      // the next attempt should retry the sub-LLM rather than serve a
      // stale "[failed]" reply.
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

/** 5-line header + body, byte-identical to the Python helper's stdout
 *  format (see webfetch.py:380-388 in PR #2). `Bytes:` reports the
 *  extracted-body utf-8 byte count, NOT raw HTTP bytes — matches the
 *  PR #2 behavior change where text content reports "what the model
 *  will actually see" rather than the larger raw-HTML count. */
function formatTextResponse(opts: {
  url: string
  status: number
  contentType: string
  bytes: number
  truncated: boolean
  body: string
}): string {
  const header = [
    `URL: ${opts.url}`,
    `Status: ${opts.status}`,
    `Content-Type: ${opts.contentType || 'unknown'}`,
    `Bytes: ${opts.bytes}${opts.truncated ? ' (truncated)' : ''}`,
    '',
  ].join('\n')
  return header + '\n' + opts.body
}

/** 5-line header + binary-body line, byte-identical to webfetch.py:347-352.
 *  `Bytes:` here IS the raw byte count (binary doesn't go through an
 *  extractor, so "what the model sees" === "what landed on disk"). */
function formatBinaryResponse(opts: {
  url: string
  status: number
  contentType: string
  bytes: number
  truncated: boolean
  filepath: string
}): string {
  const ctLabel = opts.contentType || 'unknown'
  const header = [
    `URL: ${opts.url}`,
    `Status: ${opts.status}`,
    `Content-Type: ${ctLabel}`,
    `Bytes: ${opts.bytes}${opts.truncated ? ' (truncated)' : ''}`,
    '',
  ].join('\n')
  const truncatedLabel = opts.truncated ? ' (truncated)' : ''
  return (
    header +
    '\n' +
    `[Binary content (${ctLabel}, ${formatSize(opts.bytes)})${truncatedLabel} saved to ${opts.filepath}]`
  )
}

/** Human-readable byte count. Mirrors webfetch.py:208-215 format_size. */
function formatSize(numBytes: number): string {
  if (numBytes < 1024) return `${numBytes}B`
  if (numBytes < 1024 * 1024) return `${(numBytes / 1024).toFixed(1)}KB`
  if (numBytes < 1024 * 1024 * 1024) return `${(numBytes / 1024 / 1024).toFixed(1)}MB`
  return `${(numBytes / 1024 / 1024 / 1024).toFixed(2)}GB`
}
