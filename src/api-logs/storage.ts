import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Per-query API logger. One file per `query()` call:
 *
 *   <dir>/<YYYY-MM-DD>/<sessionId>-<HHMMSS>-<uuid8>.jsonl
 *
 * Each line is a single streamChat call (one turn — or one attempt of a
 * turn when the prompt-too-long retry path runs). The full system prompt,
 * tools schema, request messages array, and response content are stored
 * verbatim — no truncation. Intended for admin debugging (correlating a
 * Bedrock 400 with the exact request shape) and as a training-data trail
 * for future model work.
 *
 * **Default off**: enabled only when admin explicitly turns it on via
 * `config.apiLogs.enabled` or `LIGHTCLAW_API_LOGS_ENABLED=1`. Multi-user
 * deployments don't burn disk recording every model call by default.
 *
 * Errors are caught and logged to stderr. Logger failures must never
 * block or fail the main query path.
 */

export interface ApiLogTurnRecord {
  turn: number
  attempt: number
  ts: string  // ISO 8601
  model: string
  request: {
    system: string | unknown
    tools: unknown[]
    messages: Array<{ role: string; content: unknown }>
    cacheBreakpointMessageIndex?: number
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
 * sessionId may contain `:` `/` etc on some channels; strip everything
 * outside `[A-Za-z0-9_-]` so the filename stays portable. Maximum 60 chars
 * to avoid OS limits when concatenated with the timestamp + uuid.
 */
function sanitizeId(input: string): string {
  return input.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60) || 'session'
}
