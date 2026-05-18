import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Per-query API logger. One file per `query()` call:
 *
 *   <dir>/<YYYY-MM-DD>/<sessionId>-<HHMMSS>-<uuid8>.jsonl
 *
 * Each line is a single streamChat call. The full system prompt, tools
 * schema, request messages array, and response content are stored verbatim —
 * no truncation. Intended for admin debugging (correlating a Bedrock 400
 * with the exact request shape) and as a training-data trail for future
 * model work.
 *
 * Coverage is universal: every streamChat call in the process is logged
 * (main loop, subagent forks, memory recall, session-memory writes, compact
 * summaries, per-tool LLM summaries). The active logger is propagated via
 * AsyncLocalStorage — `query()` opens a logger and pushes it on the scope
 * stack via `runWithApiLogger`; `streamChat` (api.ts) reads it through
 * `getActiveApiLogger()`. Subagent forks open their own logger nested
 * inside the parent scope, so extraction-internal calls land in the
 * subagent file rather than the parent file.
 *
 * **Default off**: enabled only when admin explicitly turns it on via
 * `config.apiLogsEnabled` or `LIGHTCLAW_API_LOGS_ENABLED=1`. Multi-user
 * deployments don't burn disk recording every model call by default.
 *
 * Errors are caught and logged to stderr. Logger failures must never
 * block or fail the main query path.
 */

/**
 * Which subsystem made this streamChat call. Readers consult this to filter
 * the log: `main` is the primary agent loop, `subagent` is a forked agent
 * (`subagentLabel` carries the role — `memoryExtractor`, `generalist`,
 * `localExplorer`), and the four one-shot kinds tag helper LLM calls that fire
 * inside the main query lifecycle.
 *
 * `describe-image` and `transcribe-audio` tag sub-LLM helper calls that
 * bypass `streamChat`: vision describe (OpenAI Chat/Responses tool
 * messages are string-only so we describe-and-replace image blocks via
 * `provider.describeImage`) and audio transcription (`provider.transcribeAudio`,
 * typically whisper-1 on OpenAI). These consume tokens / per-second billing
 * and matter for cost & failure analysis, so the api-logs surface tracks
 * them alongside the streamChat record kinds. Raw image bytes / audio
 * buffers are deliberately omitted from the request payload — the wrapper
 * records prompt + image_count or model + audio metadata + result text.
 *
 * `web-fetch-summarize` tags the sub-LLM call inside WebFetch that turns
 * fetched markdown into a focused answer for a user prompt. Unlike raw image
 * bytes / audio buffers, the fetched markdown body IS recorded in the request
 * payload (truncated by MAX_MARKDOWN_LENGTH) because text is bounded and
 * provides debugging signal for "why did the summary miss this fact". This
 * call still flows through `streamChat`, so the logger picks it up via the
 * apiLogContext.kind tag rather than a dedicated wrapper like describe-image.
 */
export type ApiLogKind =
  | 'main'
  | 'subagent'
  | 'recall'
  | 'session-memory'
  | 'compact'
  | 'describe-image'
  | 'transcribe-audio'
  | 'web-fetch-summarize'

export interface ApiLogTurnRecord {
  kind: ApiLogKind
  /** Forked-agent label — present only when kind === 'subagent'. */
  subagentLabel?: string
  sessionId: string
  /** Canonical user id from state; absent for terminal-only sessions. */
  user?: string
  /** Main loop turn index. Always 0 for one-shot kinds. */
  turn: number
  /** Attempt within turn (>0 only on prompt-too-long retry). */
  attempt: number
  ts: string  // ISO 8601
  model: string
  request: {
    system: string | unknown
    tools: unknown[]
    messages: Array<{ role: string; content: unknown }>
    cacheBreakpointMessageIndex?: number
    maxTokens?: number
    reasoningEffort?: string
  }
  response?: {
    content: unknown[]
    stopReason: string | null
    usage: {
      input_tokens?: number
      output_tokens?: number
      cache_creation_input_tokens?: number
      cache_read_input_tokens?: number
    }
  }
  error?: {
    name: string
    message: string
  }
}

export interface ApiLogger {
  appendTurn(record: ApiLogTurnRecord): Promise<void>
  /** Path of the file being written; useful for tests + diagnostics. */
  filePath(): string
}

export interface OpenApiLoggerInput {
  enabled: boolean
  dir: string
  sessionId: string
}

/**
 * Open a logger handle for one query. When `enabled === false`, returns a
 * no-op logger so callers don't need to branch.
 *
 * The file is created lazily on the first appendTurn call — keeps the FS
 * untouched when a query produces zero turns (e.g. early abort).
 */
export function openApiLogger(input: OpenApiLoggerInput): ApiLogger {
  if (!input.enabled) {
    return NOOP_LOGGER
  }

  const now = new Date()
  const date = now.toISOString().slice(0, 10)  // YYYY-MM-DD
  const hhmmss = now.toISOString().slice(11, 19).replace(/:/g, '')  // HHMMSS
  const uuid8 = randomUUID().slice(0, 8)
  const dayDir = path.join(input.dir, date)
  const filename = `${sanitizeId(input.sessionId)}-${hhmmss}-${uuid8}.jsonl`
  const filePath = path.join(dayDir, filename)

  let dirReady = false

  return {
    async appendTurn(record: ApiLogTurnRecord): Promise<void> {
      try {
        if (!dirReady) {
          await fs.promises.mkdir(dayDir, { recursive: true })
          dirReady = true
        }
        await fs.promises.appendFile(filePath, JSON.stringify(record) + '\n', 'utf8')
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        process.stderr.write(`[api-logs] append failed for ${filePath}: ${detail}\n`)
      }
    },
    filePath(): string {
      return filePath
    },
  }
}

const NOOP_LOGGER: ApiLogger = {
  async appendTurn(): Promise<void> {
    // intentional no-op
  },
  filePath(): string {
    return ''
  },
}

/**
 * AsyncLocalStorage-backed scope so `streamChat` (api.ts) can look up the
 * current query's logger without every helper threading an `apiLogger` arg.
 * Subagent forks call `runWithApiLogger` again with their own logger; the
 * inner store wins for the duration of the fork.
 */
const apiLoggerStorage = new AsyncLocalStorage<ApiLogger>()

export function runWithApiLogger<T>(
  logger: ApiLogger,
  fn: () => Promise<T>,
): Promise<T> {
  return apiLoggerStorage.run(logger, fn)
}

export function getActiveApiLogger(): ApiLogger | null {
  return apiLoggerStorage.getStore() ?? null
}

/**
 * sessionId may contain `:` `/` etc on some channels; strip everything
 * outside `[A-Za-z0-9_-]` so the filename stays portable. Maximum 60 chars
 * to avoid OS limits when concatenated with the timestamp + uuid.
 */
function sanitizeId(input: string): string {
  return input.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60) || 'session'
}
