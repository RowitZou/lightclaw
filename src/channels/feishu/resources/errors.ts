export type FeishuErrorKind =
  | 'scope-missing'
  | 'auth-failure'
  | 'rate-limited'
  | 'validation-failed'
  | 'already-exists'
  | 'not-found'
  | 'permission-denied'
  | 'internal-server'
  | 'transient-network'
  | 'withdrawn-target'
  | 'unknown'

export type FeishuScopeMissingInfo = {
  requiredScopes: string[]
  logId?: string
  message: string
}

export interface FeishuErrorClassification {
  kind: FeishuErrorKind
  retryable: boolean
  admin: boolean
  code?: number
  msg?: string
  logId?: string
  fieldViolations?: unknown[]
  permissionViolations?: unknown[]
  scopeMissing?: FeishuScopeMissingInfo
  agentMessage: string
  adminMessage: string
}

export class FeishuApiError extends Error {
  readonly classification: FeishuErrorClassification
  readonly feishuScopeMissing?: FeishuScopeMissingInfo

  constructor(classification: FeishuErrorClassification, cause?: unknown) {
    super(classification.agentMessage)
    this.name = 'FeishuApiError'
    this.classification = classification
    if (classification.scopeMissing) {
      this.feishuScopeMissing = classification.scopeMissing
    }
    if (cause !== undefined) {
      ;(this as { cause?: unknown }).cause = cause
    }
  }
}

const TRANSIENT_ERROR_CODES = new Set([
  'ECONNABORTED', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE',
])
const TRANSIENT_MESSAGE_PATTERN =
  /(timeout|timed out|socket hang up|tls|secure|disconnect|EOF while reading|EOF\b)/i

const AUTH_FAILURE_CODES = new Set([99991663, 99991664, 99991665, 99991543, 99991673, 10005, 10015])
const RATE_LIMIT_CODES = new Set([99991400, 99991403, 1000004, 1000005, 11232, 11233, 11247, 90217, 90235, 96201, 96202])
const WITHDRAWN_TARGET_CODES = new Set([230011, 231003])
const NOT_FOUND_CODES = new Set([1002, 600, 11244, 18066, 90304, 90305, 91005, 91205, 95007, 1069304, 95006, 91402, 99992355, 99992375, 99992379])
const PERMISSION_DENIED_CODES = new Set([91002, 91204, 95008, 95009, 90213, 91003, 91004, 1069303, 11201, 11202, 11208, 99991679])
const INTERNAL_SERVER_CODES = new Set([1500, 1503, 1665, 1668, 2200, 5000, 45500, 55001, 95001, 95003, 95005, 95010, 95011, 105001, 1000003, 90203, 90242, 90228])

export function classifyFeishuError(error: unknown): FeishuErrorClassification {
  if (error instanceof FeishuApiError) {
    return error.classification
  }

  const envelope = extractEnvelope(error)
  const httpStatus = extractHttpStatus(error)
  const scopeMissing = detectFeishuScopeMissingFromEnvelope(envelope)
  const code = envelope.code
  const msg = envelope.msg

  let kind: FeishuErrorKind = 'unknown'
  if (isTransientNetworkError(error)) {
    kind = 'transient-network'
  } else if (scopeMissing || code === 99991672) {
    kind = 'scope-missing'
  } else if (code !== undefined && AUTH_FAILURE_CODES.has(code)) {
    kind = 'auth-failure'
  } else if ((code !== undefined && RATE_LIMIT_CODES.has(code)) || httpStatus === 429) {
    kind = 'rate-limited'
  } else if (code !== undefined && WITHDRAWN_TARGET_CODES.has(code)) {
    kind = 'withdrawn-target'
  } else if ((code !== undefined && /^99992\d{3}$/.test(String(code))) || envelope.fieldViolations.length > 0) {
    kind = 'validation-failed'
  } else if ((code !== undefined && /^1061\d{3}$/.test(String(code))) || /already exist|already been added|been added|duplicate|repeat/i.test(msg ?? '')) {
    kind = 'already-exists'
  } else if (code !== undefined && NOT_FOUND_CODES.has(code)) {
    kind = 'not-found'
  } else if (code !== undefined && PERMISSION_DENIED_CODES.has(code)) {
    kind = 'permission-denied'
  } else if ((code !== undefined && (INTERNAL_SERVER_CODES.has(code) || /^952[0-49]\d$/.test(String(code)))) || (httpStatus !== undefined && httpStatus >= 500)) {
    kind = 'internal-server'
  }

  const retryable = kind === 'rate-limited' || kind === 'internal-server' || kind === 'transient-network'
  const admin = kind === 'scope-missing' || kind === 'auth-failure'
  const base: Omit<FeishuErrorClassification, 'agentMessage' | 'adminMessage'> = {
    kind,
    retryable,
    admin,
    ...(code !== undefined ? { code } : {}),
    ...(msg !== undefined ? { msg } : {}),
    ...(envelope.logId ? { logId: envelope.logId } : {}),
    ...(envelope.fieldViolations.length > 0 ? { fieldViolations: envelope.fieldViolations } : {}),
    ...(envelope.permissionViolations.length > 0 ? { permissionViolations: envelope.permissionViolations } : {}),
    ...(scopeMissing ? { scopeMissing } : {}),
  }
  const messages = buildMessages(base, error)
  return { ...base, ...messages }
}

export function logFeishuRetry(
  c: FeishuErrorClassification,
  attempt: number,
  delayMs: number,
  op = 'unknown',
): void {
  process.stderr.write(
    `[feishu retry] op=${op} attempt=${attempt} kind=${c.kind} delay=${delayMs}ms${c.logId ? ` log_id=${c.logId}` : ''}\n`,
  )
}

export function detectFeishuScopeMissing(error: unknown): FeishuScopeMissingInfo | null {
  return detectFeishuScopeMissingFromEnvelope(extractEnvelope(error))
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

export function formatFeishuHttpError(error: unknown): string {
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

type ExtractedEnvelope = {
  code?: number
  msg?: string
  logId?: string
  fieldViolations: unknown[]
  permissionViolations: unknown[]
}

function extractEnvelope(error: unknown): ExtractedEnvelope {
  const response = (error as { response?: { data?: unknown; headers?: Record<string, unknown>; status?: number } })?.response
  const rawBody = response?.data ?? error
  const body = parseObject(rawBody)
  const errorField = parseObject(body?.error)
  const headerLogId = response?.headers?.['x-tt-logid'] ?? response?.headers?.['x-tt-log-id']
  const bodyLogId = typeof errorField?.log_id === 'string'
    ? errorField.log_id
    : typeof body?.log_id === 'string'
      ? body.log_id
      : undefined
  const code = numberFrom(body?.code)
  const msg = typeof body?.msg === 'string'
    ? body.msg
    : typeof body?.message === 'string'
      ? body.message
      : undefined

  return {
    ...(code !== undefined ? { code } : {}),
    ...(msg !== undefined ? { msg } : {}),
    ...(headerLogId != null ? { logId: String(headerLogId) } : bodyLogId ? { logId: bodyLogId } : {}),
    fieldViolations: arrayFrom(errorField?.field_violations ?? body?.field_violations),
    permissionViolations: arrayFrom(errorField?.permission_violations ?? body?.permission_violations),
  }
}

function extractHttpStatus(error: unknown): number | undefined {
  return numberFrom((error as { response?: { status?: unknown }; status?: unknown })?.response?.status)
    ?? numberFrom((error as { status?: unknown })?.status)
}

function detectFeishuScopeMissingFromEnvelope(envelope: ExtractedEnvelope): FeishuScopeMissingInfo | null {
  const requiredScopes: string[] = []
  for (const v of envelope.permissionViolations) {
    if (v && typeof v === 'object' && (v as { type?: unknown }).type === 'action_scope_required') {
      const subject = (v as { subject?: unknown }).subject
      if (typeof subject === 'string' && subject.length > 0) {
        requiredScopes.push(subject)
      }
    }
  }
  const msg = envelope.msg ?? ''
  const isTextMatch = /scope[s]?\s+(?:is|are)?\s*required/i.test(msg)
    || /应用尚未开通所需的应用身份权限/.test(msg)
  if (requiredScopes.length === 0 && !isTextMatch) return null
  if (requiredScopes.length === 0 && msg) {
    const bracket = msg.match(/\[([^\]]+)\]/)
    if (bracket) {
      for (const piece of bracket[1].split(',')) {
        const trimmed = piece.trim()
        if (trimmed.length > 0) requiredScopes.push(trimmed)
      }
    }
  }
  return {
    requiredScopes,
    ...(envelope.logId ? { logId: envelope.logId } : {}),
    message: msg || 'Feishu API scope check failed',
  }
}

function buildMessages(
  c: Omit<FeishuErrorClassification, 'agentMessage' | 'adminMessage'>,
  error: unknown,
): { agentMessage: string; adminMessage: string } {
  const head = [
    `Feishu API error [${c.kind}]`,
    c.code !== undefined ? `code=${c.code}` : null,
    c.msg ? `msg=${c.msg}` : null,
    c.logId ? `log_id=${c.logId}` : null,
  ].filter(Boolean).join(' ')
  const raw = formatFeishuHttpError(error)
  const withRaw = raw && raw !== head ? `${head}\n${raw}` : head

  switch (c.kind) {
    case 'scope-missing': {
      const scopes = c.scopeMissing?.requiredScopes.length
        ? c.scopeMissing.requiredScopes.join(', ')
        : '(see Feishu Developer Console)'
      const message = `${head}\nRequired scopes: ${scopes}. Enable in Developer Console and re-publish app.`
      const adminMessage = `飞书应用 scope 缺失。需要在 Developer Console 开通: ${scopes}, 然后重新发版应用。${c.logId ? ` log_id=${c.logId}` : ''}`
      return { agentMessage: message, adminMessage }
    }
    case 'auth-failure': {
      const hint = '飞书 token 或 credentials 失效。检查 ~/.lightclaw/channels.json 的 appId/appSecret, 或重启 daemon 让 tenant_access_token 刷新。Check Feishu app credentials or restart daemon to refresh tenant_access_token.'
      return { agentMessage: `${withRaw}\n${hint}`, adminMessage: `${head}\n${hint}` }
    }
    case 'rate-limited':
      return { agentMessage: `${withRaw}\nRate limited by Feishu. Will retry automatically if invoked via withFeishuRetry.`, adminMessage: withRaw }
    case 'validation-failed':
      return { agentMessage: appendFieldViolations(withRaw, c.fieldViolations), adminMessage: appendFieldViolations(withRaw, c.fieldViolations) }
    case 'already-exists':
      return { agentMessage: `${withRaw}\nResource already exists (idempotent - caller may treat as success).`, adminMessage: withRaw }
    case 'not-found':
      return { agentMessage: `${withRaw}\nFeishu resource not found or already deleted. Token may be revoked or moved to trash.`, adminMessage: withRaw }
    case 'permission-denied':
      return { agentMessage: `${withRaw}\nPermission denied - user/admin should grant access.`, adminMessage: withRaw }
    case 'internal-server':
      return { agentMessage: `${withRaw}\nFeishu internal server error. Retryable.`, adminMessage: withRaw }
    case 'transient-network':
      return { agentMessage: `${withRaw}\nNetwork transient error. Retryable.`, adminMessage: withRaw }
    case 'withdrawn-target':
      return { agentMessage: `${withRaw}\nReply target message withdrawn. Caller should fallback to create.`, adminMessage: withRaw }
    case 'unknown':
      return { agentMessage: withRaw, adminMessage: withRaw }
  }
}

function appendFieldViolations(message: string, fieldViolations: unknown[] | undefined): string {
  if (!fieldViolations?.length) return message
  const rendered = fieldViolations.map(v => {
    if (!v || typeof v !== 'object') return String(v)
    const obj = v as Record<string, unknown>
    return [
      obj.field !== undefined ? `field=${String(obj.field)}` : null,
      obj.value !== undefined ? `value=${JSON.stringify(obj.value)}` : null,
      obj.description !== undefined ? `description=${String(obj.description)}` : null,
    ].filter(Boolean).join(' ')
  }).join('\n')
  return `${message}\nField violations:\n${rendered}`
}

function isTransientNetworkError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }
  const e = error as { code?: unknown; cause?: unknown; message?: unknown }
  if (typeof e.code === 'string' && TRANSIENT_ERROR_CODES.has(e.code)) {
    return true
  }
  if (typeof e.cause === 'object' && e.cause) {
    const causeCode = (e.cause as { code?: unknown }).code
    if (typeof causeCode === 'string' && TRANSIENT_ERROR_CODES.has(causeCode)) {
      return true
    }
  }
  return typeof e.message === 'string' && TRANSIENT_MESSAGE_PATTERN.test(e.message)
}

function parseObject(input: unknown): Record<string, unknown> | null {
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input)
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
    } catch {
      return null
    }
  }
  return input && typeof input === 'object' ? input as Record<string, unknown> : null
}

function arrayFrom(input: unknown): unknown[] {
  return Array.isArray(input) ? input : []
}

function numberFrom(input: unknown): number | undefined {
  if (typeof input === 'number' && Number.isFinite(input)) return input
  if (typeof input === 'string' && /^\d+$/.test(input)) return Number(input)
  return undefined
}
