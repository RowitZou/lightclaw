import { fetch, ProxyAgent } from 'undici'

export const DEFAULT_WEB_FETCH_TIMEOUT_MS = 15_000

export type FetchResult = {
  url: string
  status: number
  contentType: string
  bytes: number
  content: string
  truncated: boolean
}

function getProxyUrl(): string | undefined {
  return (
    process.env.HTTPS_PROXY ??
    process.env.https_proxy ??
    process.env.HTTP_PROXY ??
    process.env.http_proxy
  )
}

function combineSignals(left: AbortSignal, right?: AbortSignal): AbortSignal {
  if (!right) {
    return left
  }

  return AbortSignal.any([left, right])
}

export async function fetchContent(params: {
  url: string
  maxBytes: number
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<FetchResult> {
  const url = new URL(params.url)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http and https URLs are supported.')
  }

  const timeoutMs = params.timeoutMs ?? DEFAULT_WEB_FETCH_TIMEOUT_MS
  const timeoutController = new AbortController()
  const timeout = setTimeout(() => timeoutController.abort(), timeoutMs)

  const proxyUrl = getProxyUrl()
  try {
    const response = await fetch(url, {
      signal: combineSignals(timeoutController.signal, params.signal),
      dispatcher: proxyUrl ? new ProxyAgent(proxyUrl) : undefined,
      headers: {
        'User-Agent': 'LightClaw/0.1 (+https://github.com/RowitZou/lightclaw)',
        Accept: 'text/html,text/plain,application/json,text/markdown,*/*;q=0.8',
      },
    })

    const contentType =
      response.headers.get('content-type') ?? 'application/octet-stream'
    const chunks: Uint8Array[] = []
    let bytes = 0
    let truncated = false

    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      if (bytes >= params.maxBytes) {
        truncated = true
        break
      }

      const remaining = params.maxBytes - bytes
      const next = chunk.length > remaining ? chunk.slice(0, remaining) : chunk
      chunks.push(next)
      bytes += next.length

      if (chunk.length > remaining) {
        truncated = true
        break
      }
    }

    return {
      url: response.url,
      status: response.status,
      contentType,
      bytes,
      content: Buffer.concat(chunks).toString('utf8'),
      truncated,
    }
  } finally {
    clearTimeout(timeout)
  }
}
