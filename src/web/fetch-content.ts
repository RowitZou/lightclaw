import { fetch, ProxyAgent } from 'undici'

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

  const controller = new AbortController()
  const abort = () => controller.abort()
  left.addEventListener('abort', abort, { once: true })
  right.addEventListener('abort', abort, { once: true })
  return controller.signal
}

export async function fetchContent(params: {
  url: string
  maxBytes: number
  signal?: AbortSignal
}): Promise<FetchResult> {
  const url = new URL(params.url)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http and https URLs are supported.')
  }

  const timeoutController = new AbortController()
  const timeout = setTimeout(() => timeoutController.abort(), 15_000)

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
