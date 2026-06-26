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

/**
 * Candidate base-urls to probe for an apiKey endpoint, in priority order.
 *
 * The two SDK families take their `baseURL` differently — OpenAI's includes the
 * `/v1` path segment (`https://api.openai.com/v1`, the SDK appends only
 * `/chat/completions`), while Anthropic's does NOT (`https://api.anthropic.com`,
 * the SDK appends `/v1/messages` itself). Users routinely paste the wrong shape
 * (most often a bare `host:port` for an openai gateway that needs `/v1`). Rather
 * than blindly rewriting — which would break a gateway that genuinely serves at
 * a non-standard path — we try the value AS-GIVEN first, then the
 * convention-corrected alternative, and the caller keeps whichever responds.
 */
export function apiKeyBaseUrlCandidates(
  type: 'openai' | 'anthropic',
  baseUrl: string | undefined,
): (string | undefined)[] {
  if (baseUrl === undefined) return [undefined]
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  if (!trimmed) return [undefined]
  const endsWithV1 = /\/v1$/i.test(trimmed)
  if (type === 'openai') {
    // openai baseURL should end in /v1; offer the +/v1 form when it's missing.
    return endsWithV1 ? [trimmed] : [trimmed, `${trimmed}/v1`]
  }
  // anthropic baseURL should NOT end in /v1 (the SDK adds it); offer the
  // stripped form when the user included it.
  return endsWithV1 ? [trimmed, trimmed.replace(/\/v1$/i, '')] : [trimmed]
}

/**
 * Like {@link listApiKeyModels}, but tolerant of the `/v1` base-url convention
 * (see {@link apiKeyBaseUrlCandidates}). Tries each candidate and returns the
 * first that lists models, falling back to the first that is merely reachable
 * (2xx + valid JSON, empty list), else the first error. `resolvedBaseUrl` is the
 * base-url that actually responded — the caller should persist / display THAT so
 * the stored endpoint matches the wire path the probe verified.
 */
export async function listApiKeyModelsResolvingBaseUrl(input: {
  type: 'openai' | 'anthropic'
  apiKey: string
  baseUrl?: string
  proxy?: string
  limit?: number
  timeoutMs?: number
  http?: ListModelsHttpFn
}): Promise<ListModelsResult & { resolvedBaseUrl?: string }> {
  const candidates = apiKeyBaseUrlCandidates(input.type, input.baseUrl)
  let firstReachable: { models: string[]; baseUrl: string | undefined } | null = null
  let firstError: { ok: false; error: string } | null = null
  for (const candidate of candidates) {
    const result = await listApiKeyModels({ ...input, baseUrl: candidate })
    if (result.ok && result.models.length > 0) {
      return { ok: true, models: result.models, resolvedBaseUrl: candidate }
    }
    if (result.ok && !firstReachable) firstReachable = { models: result.models, baseUrl: candidate }
    if (!result.ok && !firstError) firstError = result
  }
  if (firstReachable) {
    return { ok: true, models: firstReachable.models, resolvedBaseUrl: firstReachable.baseUrl }
  }
  return firstError ?? { ok: false, error: 'unreachable' }
}
