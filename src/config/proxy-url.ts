const MARKDOWN_LINK_RE = /^\[([^\]]+)]\(([^)\s]+)\)$/

export function normalizeProxyUrl(raw: string): string {
  const unwrapped = unwrapProxyUrl(raw)
  let url: URL
  try {
    url = new URL(unwrapped)
  } catch {
    throw new Error(`proxy must be a valid http(s) URL, got "${raw}"`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`proxy must use http:// or https://, got "${raw}"`)
  }
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) {
    throw new Error(`proxy URL must not include path, query, or hash, got "${raw}"`)
  }
  const auth = url.username
    ? `${url.username}${url.password ? `:${url.password}` : ''}@`
    : ''
  return `${url.protocol}//${auth}${url.host}`
}

function unwrapProxyUrl(raw: string): string {
  const trimmed = raw.trim()
  const markdown = MARKDOWN_LINK_RE.exec(trimmed)
  if (markdown) {
    return markdown[2]!.trim()
  }
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}
