export type FeishuEnvelope<T = unknown> = {
  code?: number
  msg?: string
  data?: T
}

export async function callFeishu<T extends FeishuEnvelope>(
  fn: () => Promise<T>,
): Promise<T> {
  const result = await fn()
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
