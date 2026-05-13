export type FeishuEnvelope<T = unknown> = {
  code?: number
  msg?: string
  data?: T
}

export type FeishuScopeMissingInfo = {
  /**
   * Scope names Feishu listed as acceptable. Any one of them grants the
   * call. Empty when we matched on message-only and couldn't parse the
   * bracketed list out — admin still gets a usable error, just less
   * specific.
   */
  requiredScopes: string[]
  /** x-tt-logid from the response headers or error.log_id, for cross-ref with Feishu support. */
  logId?: string
  /** Raw Feishu `msg` string (mixed English + Chinese) for debugging. */
  message: string
}

/**
 * Recognize the "you forgot to enable a scope" family of Feishu errors.
 *
 * We deliberately don't pin to a single error code (Feishu cycles codes
 * occasionally — today `drive:drive` returns `99991672`, tomorrow a
 * different module's scope-missing might land on a different code). Match
 * on the structural signal Feishu actually keeps stable:
 *
 *   1. `error.permission_violations[].type === 'action_scope_required'` —
 *      the canonical machine-readable shape, lists exactly which scopes
 *      would satisfy the call.
 *   2. Fallback: message text contains `scope[s] (is|are) required` (en)
 *      or `应用尚未开通所需的应用身份权限` (zh).
 *
 * Returns null when the error is something else (network, malformed body,
 * unrelated 4xx, etc.) — callers should keep their normal error path.
 */
export function detectFeishuScopeMissing(error: unknown): FeishuScopeMissingInfo | null {
  const response = (error as { response?: {
    data?: unknown
    headers?: Record<string, unknown>
  } })?.response
  if (!response) return null

  const rawBody = response.data
  let body: Record<string, unknown> | null = null
  if (typeof rawBody === 'string') {
    try { body = JSON.parse(rawBody) as Record<string, unknown> } catch { body = null }
  } else if (rawBody && typeof rawBody === 'object') {
    body = rawBody as Record<string, unknown>
  }
  if (!body) return null

  const errorField = (body.error && typeof body.error === 'object'
    ? body.error as Record<string, unknown>
    : null)

  const requiredScopes: string[] = []
  const violations = errorField?.permission_violations
  if (Array.isArray(violations)) {
    for (const v of violations) {
      if (v && typeof v === 'object' && (v as { type?: unknown }).type === 'action_scope_required') {
        const subject = (v as { subject?: unknown }).subject
        if (typeof subject === 'string' && subject.length > 0) {
          requiredScopes.push(subject)
        }
      }
    }
  }

  const msg = typeof body.msg === 'string' ? body.msg : ''
  const isTextMatch = /scope[s]?\s+(?:is|are)?\s*required/i.test(msg)
    || /应用尚未开通所需的应用身份权限/.test(msg)

  if (requiredScopes.length === 0 && !isTextMatch) return null

  // If structured violations were absent, try to lift the scope list out
  // of the bracketed segment in the message ("[drive:drive, ...]").
  if (requiredScopes.length === 0 && msg) {
    const bracket = msg.match(/\[([^\]]+)\]/)
    if (bracket) {
      for (const piece of bracket[1].split(',')) {
        const trimmed = piece.trim()
        if (trimmed.length > 0) requiredScopes.push(trimmed)
      }
    }
  }

  const headerLogId = response.headers?.['x-tt-logid'] ?? response.headers?.['x-tt-log-id']
  const bodyLogId = typeof errorField?.log_id === 'string' ? errorField.log_id : undefined
  const logId = (headerLogId != null ? String(headerLogId) : undefined) ?? bodyLogId

  return {
    requiredScopes,
    ...(logId ? { logId } : {}),
    message: msg || 'Feishu API scope check failed',
  }
}

export function formatFeishuScopeMissing(info: FeishuScopeMissingInfo): string {
  const scopes = info.requiredScopes.length > 0
    ? info.requiredScopes.join(' or ')
    : '(see Feishu Developer Console)'
  return [
    'Feishu app scope missing.',
    `Required: ${scopes}.`,
    'Enable the scope in the Feishu Developer Console and re-publish the app version (Feishu self-build apps require a fresh version release for scope changes to take effect).',
    info.logId ? `x-tt-logid=${info.logId}` : null,
  ].filter(Boolean).join(' ')
}

export async function callFeishu<T extends FeishuEnvelope>(
  fn: () => Promise<T>,
): Promise<T> {
  let result: T
  try {
    result = await fn()
  } catch (error) {
    // Centralized scope-missing translation: every Feishu API call (drive,
    // im, contact, ...) routes through callFeishu, so detecting here turns
    // an opaque `axios 400` into a clear "scope missing, re-publish app
    // version" message for every downstream catch site (agent tools,
    // lifecycle preheat, admin slash).
    const scope = detectFeishuScopeMissing(error)
    if (scope) {
      throw Object.assign(new Error(formatFeishuScopeMissing(scope)), {
        feishuScopeMissing: scope,
        cause: error,
      })
    }
    throw error
  }
  if (typeof result?.code === 'number' && result.code !== 0) {
    throw new Error(`Feishu API error ${result.code}: ${result.msg ?? 'unknown error'}`)
  }
  return result
}

export function feishuErrorMessage(error: unknown): string {
  const response = (error as {
    response?: {
      status?: number
      statusText?: string
      data?: unknown
      headers?: Record<string, unknown>
    }
  })?.response
  if (response) {
    const status = [response.status, response.statusText].filter(Boolean).join(' ')
    const data = typeof response.data === 'string'
      ? response.data
      : JSON.stringify(response.data)
    const logId = response.headers?.['x-tt-logid'] ?? response.headers?.['x-tt-log-id']
    return [
      status ? `Feishu HTTP ${status}` : 'Feishu HTTP error',
      data ? `body=${data}` : undefined,
      logId ? `x-tt-logid=${String(logId)}` : undefined,
    ].filter(Boolean).join('; ')
  }
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}
