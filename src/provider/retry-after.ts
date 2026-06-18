function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (!headers) {
    return undefined
  }
  if (typeof (headers as { get?: unknown }).get === 'function') {
    const value = (headers as { get(name: string): string | null }).get(name)
    return value ?? undefined
  }
  if (!isRecord(headers)) {
    return undefined
  }
  const normalized = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== normalized) {
      continue
    }
    if (typeof value === 'string' || typeof value === 'number') {
      return String(value)
    }
    if (Array.isArray(value)) {
      const first = value.find(item => typeof item === 'string' || typeof item === 'number')
      return first === undefined ? undefined : String(first)
    }
  }
  return undefined
}

function positiveMs(value: number): number | undefined {
  if (!Number.isFinite(value) || value <= 0) {
    return undefined
  }
  return Math.ceil(value)
}

function parseRetryAfter(headers: unknown, nowMs: number): number | undefined {
  const retryAfterMs = headerValue(headers, 'retry-after-ms')
  if (retryAfterMs !== undefined) {
    return positiveMs(Number(retryAfterMs))
  }

  const retryAfter = headerValue(headers, 'retry-after')
  if (retryAfter === undefined) {
    return undefined
  }
  const trimmed = retryAfter.trim()
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    return positiveMs(Number(trimmed) * 1000)
  }
  const dateMs = Date.parse(trimmed)
  return positiveMs(dateMs - nowMs)
}

export function extractProviderRetryAfterMs(
  error: unknown,
  nowMs = Date.now(),
): number | undefined {
  if (!isRecord(error)) {
    return undefined
  }
  const response = isRecord(error.response) ? error.response : undefined
  for (const headers of [error.headers, response?.headers]) {
    const parsed = parseRetryAfter(headers, nowMs)
    if (parsed !== undefined) {
      return parsed
    }
  }
  return undefined
}

export function attachProviderRetryAfter(error: unknown): unknown {
  const retryAfterMs = extractProviderRetryAfterMs(error)
  if (retryAfterMs !== undefined && isRecord(error)) {
    error.retryAfterMs = retryAfterMs
  }
  return error
}
