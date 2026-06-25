import { request, type Dispatcher } from 'undici'

import { buildProxyDispatcher } from '../../provider/proxy.js'
import { CODEX_BACKEND_BASE_URL } from './constants.js'
import type { AuthCredentials } from '../types.js'

// Live discovery of Codex backend's available models. Hits
// `<base>/models?client_version=1.0.0` with the same Authorization +
// chatgpt-account-id headers we send for the streaming API. Returns the
// `slug` of the highest-priority entry that is api-callable and visible
// (priority is the upstream's own ranking — 0 is best, larger is older /
// less preferred). Returns null on any failure so callers can fall back
// to the hardcoded default — discovery is opportunistic, never required.
//
// Mirrors hermes_cli/codex_models.py:_fetch_models_from_api but without
// the synthetic forward-compat templates (those guess at unreleased
// slugs; if a user lands here the upstream is already telling us what
// is real).

type CodexModelEntry = {
  slug?: unknown
  priority?: unknown
  supported_in_api?: unknown
  visibility?: unknown
}

type CodexModelsResponse = {
  models?: unknown
}

export type ModelsHttpFn = (input: {
  url: string
  headers: Record<string, string>
}) => Promise<{ statusCode: number; bodyText: string }>

const DEFAULT_TIMEOUT_MS = 8000

function buildDefaultHttp(dispatcher: Dispatcher | undefined): ModelsHttpFn {
  return async ({ url, headers }) => {
    const res = await request(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      ...(dispatcher ? { dispatcher } : {}),
    })
    const bodyText = await res.body.text()
    return { statusCode: res.statusCode, bodyText }
  }
}

/**
 * Pure parser, exported so tests can hit it without faking HTTP. Returns
 * the api-callable, visible slugs sorted best-first (priority asc, then
 * slug name), capped at `limit`. Empty when the response carries no usable
 * entry.
 */
export function selectCodexSlugs(payload: unknown, limit = 20): string[] {
  if (!payload || typeof payload !== 'object') return []
  const list = (payload as CodexModelsResponse).models
  if (!Array.isArray(list)) return []
  const candidates: { slug: string; priority: number }[] = []
  for (const raw of list as CodexModelEntry[]) {
    if (!raw || typeof raw !== 'object') continue
    if (typeof raw.slug !== 'string' || raw.slug.length === 0) continue
    if (raw.supported_in_api === false) continue
    if (typeof raw.visibility === 'string') {
      const v = raw.visibility.trim().toLowerCase()
      if (v === 'hide' || v === 'hidden') continue
    }
    const priority =
      typeof raw.priority === 'number' && Number.isFinite(raw.priority)
        ? raw.priority
        : 10_000
    candidates.push({ slug: raw.slug, priority })
  }
  candidates.sort((a, b) =>
    a.priority !== b.priority
      ? a.priority - b.priority
      : a.slug.localeCompare(b.slug),
  )
  return candidates.slice(0, Math.max(0, limit)).map(c => c.slug)
}

/**
 * Pure parser, exported so tests can hit it without faking HTTP. Returns
 * the slug to register, or null if the response has no usable entry.
 */
export function selectDefaultCodexSlug(payload: unknown): string | null {
  return selectCodexSlugs(payload, 1)[0] ?? null
}

/**
 * Fetch the Codex backend's model list and return up to `limit` api-callable
 * visible slugs (best-first). Never throws — opportunistic discovery; on any
 * error returns null so the caller can fall back to a soft "couldn't list"
 * message. Distinguished from `[]` (connected, but no usable models).
 */
export async function listCodexSlugs(
  credentials: AuthCredentials,
  opts: { http?: ModelsHttpFn; baseUrl?: string; proxy?: string; limit?: number } = {},
): Promise<string[] | null> {
  const http = opts.http ?? buildDefaultHttp(buildProxyDispatcher(opts.proxy))
  const base = (opts.baseUrl ?? CODEX_BACKEND_BASE_URL).replace(/\/+$/, '')
  const url = `${base}/models?client_version=1.0.0`
  try {
    const { statusCode, bodyText } = await http({
      url,
      headers: {
        authorization: `Bearer ${credentials.accessToken}`,
        accept: 'application/json',
        ...(credentials.accountId
          ? { 'chatgpt-account-id': credentials.accountId }
          : {}),
      },
    })
    if (statusCode !== 200) return null
    let parsed: unknown
    try {
      parsed = JSON.parse(bodyText)
    } catch {
      return null
    }
    return selectCodexSlugs(parsed, opts.limit ?? 20)
  } catch {
    return null
  }
}

/**
 * Fetch the Codex backend's model list and return the priority-0 slug.
 * Never throws — opportunistic discovery; on any error returns null and
 * lets the caller fall back to the static default.
 */
export async function discoverDefaultCodexSlug(
  credentials: AuthCredentials,
  opts: { http?: ModelsHttpFn; baseUrl?: string; proxy?: string } = {},
): Promise<string | null> {
  const http = opts.http ?? buildDefaultHttp(buildProxyDispatcher(opts.proxy))
  const base = (opts.baseUrl ?? CODEX_BACKEND_BASE_URL).replace(/\/+$/, '')
  const url = `${base}/models?client_version=1.0.0`
  try {
    const { statusCode, bodyText } = await http({
      url,
      headers: {
        authorization: `Bearer ${credentials.accessToken}`,
        accept: 'application/json',
        ...(credentials.accountId
          ? { 'chatgpt-account-id': credentials.accountId }
          : {}),
      },
    })
    if (statusCode !== 200) return null
    let parsed: unknown
    try {
      parsed = JSON.parse(bodyText)
    } catch {
      return null
    }
    return selectDefaultCodexSlug(parsed)
  } catch {
    return null
  }
}
