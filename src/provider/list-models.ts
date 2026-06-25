import { request, type Dispatcher } from 'undici'

import { buildProxyDispatcher } from './proxy.js'

// Lightweight model-list probe for apiKey endpoints (openai / anthropic). Used
// by `/config endpoint add` to (a) verify the endpoint is reachable and (b)
// surface the upstream's own model ids so the user knows what to pass as
// `--upstream` when they add a backend. A cheap GET — no generation, no token
// spend. Codex (openai-auth) discovery lives in auth/codex/models.ts because it
// needs the OAuth credential store; this module covers the apiKey families.

export type ListModelsResult =
  | { ok: true; models: string[] }
  | { ok: false; error: string }

export type ListModelsHttpFn = (input: {
  url: string
  headers: Record<string, string>
}) => Promise<{ statusCode: number; bodyText: string }>

const DEFAULT_TIMEOUT_MS = 8000

function buildDefaultHttp(
  dispatcher: Dispatcher | undefined,
  timeoutMs: number,
): ListModelsHttpFn {
  return async ({ url, headers }) => {
    const res = await request(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
      ...(dispatcher ? { dispatcher } : {}),
    })
    const bodyText = await res.body.text()
    return { statusCode: res.statusCode, bodyText }
  }
}

/** Parse `{ data: [{ id }] }` (openai + anthropic share this shape) into the
 *  first `limit` model ids, preserving the upstream's own ordering. */
export function selectApiKeyModelIds(payload: unknown, limit = 20): string[] {
  if (!payload || typeof payload !== 'object') return []
  const list = (payload as { data?: unknown }).data
  if (!Array.isArray(list)) return []
  const ids: string[] = []
  for (const raw of list) {
    if (raw && typeof raw === 'object' && typeof (raw as { id?: unknown }).id === 'string') {
      const id = (raw as { id: string }).id
      if (id.length > 0) ids.push(id)
    }
  }
  return ids.slice(0, Math.max(0, limit))
}

/**
 * List the models an apiKey endpoint advertises. Returns `{ ok:false }` with a
 * short, user-facing reason on any transport/HTTP failure so the caller can
 * print a soft "couldn't reach the service" line; the endpoint stays saved.
 */
export async function listApiKeyModels(input: {
  type: 'openai' | 'anthropic'
  apiKey: string
  baseUrl?: string
  proxy?: string
  limit?: number
  timeoutMs?: number
  http?: ListModelsHttpFn
}): Promise<ListModelsResult> {
  const http =
    input.http ??
    buildDefaultHttp(buildProxyDispatcher(input.proxy), input.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const { url, headers } =
    input.type === 'anthropic'
      ? {
          url: `${(input.baseUrl ?? 'https://api.anthropic.com').replace(/\/+$/, '')}/v1/models`,
          headers: {
            'x-api-key': input.apiKey,
            'anthropic-version': '2023-06-01',
            accept: 'application/json',
          },
        }
      : {
          url: `${(input.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '')}/models`,
          headers: {
            authorization: `Bearer ${input.apiKey}`,
            accept: 'application/json',
          },
        }
  try {
    const { statusCode, bodyText } = await http({ url, headers })
    if (statusCode < 200 || statusCode >= 300) {
      // Trim the body so a verbose HTML error page doesn't flood the card.
      const snippet = bodyText.trim().slice(0, 200)
      return { ok: false, error: `HTTP ${statusCode}${snippet ? ` — ${snippet}` : ''}` }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(bodyText)
    } catch {
      return { ok: false, error: 'invalid JSON response' }
    }
    return { ok: true, models: selectApiKeyModelIds(parsed, input.limit ?? 20) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
