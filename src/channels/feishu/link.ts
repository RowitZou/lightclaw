export type FeishuResourceType = 'docx' | 'doc' | 'wiki' | 'sheet' | 'bitable' | 'file' | 'unknown'

export type FeishuResolvedLink = {
  ok: true
  url: string
  host: string
  resourceType: FeishuResourceType
  token: string
  sheetId?: string
  range?: string
}

export type FeishuResolveLinkResult =
  | FeishuResolvedLink
  | { ok: false; url: string; reason: string }

export function resolveFeishuLink(rawUrl: string): FeishuResolveLinkResult {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { ok: false, url: rawUrl, reason: 'Invalid URL.' }
  }

  if (!isFeishuHost(url.hostname)) {
    return { ok: false, url: rawUrl, reason: `Unsupported host: ${url.hostname}` }
  }

  const segments = url.pathname.split('/').filter(Boolean)
  const markerIndex = segments.findIndex(segment => KNOWN_SEGMENTS.has(segment.toLowerCase()))
  if (markerIndex < 0) {
    return { ok: false, url: rawUrl, reason: 'No supported Feishu resource segment found.' }
  }

  const segment = segments[markerIndex]!.toLowerCase()
  const token = segments[markerIndex + 1]?.trim()
  if (!token) {
    return { ok: false, url: rawUrl, reason: `Missing token after ${segment}.` }
  }

  const resourceType = segmentToResourceType(segment)
  const sheetId = url.searchParams.get('sheet') ??
    url.searchParams.get('sheet_id') ??
    readSheetIdFromHash(url.hash)
  const range = url.searchParams.get('range') ?? undefined

  return {
    ok: true,
    url: url.toString(),
    host: url.hostname,
    resourceType,
    token,
    ...(sheetId ? { sheetId } : {}),
    ...(range ? { range } : {}),
  }
}

// Folder links (`/drive/folder/<token>`) are deliberately NOT in
// KNOWN_SEGMENTS — a folder is not a readable doc/sheet, so `resolveFeishuLink`
// rejects them. But the rejection reason ("No supported Feishu resource
// segment found") gives the agent no path forward. This helper recognizes a
// folder URL just enough for FeishuRead to redirect the caller to FeishuList,
// without widening the readable-resource type surface.
export function parseFeishuFolderToken(rawUrl: string): string | undefined {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return undefined
  }
  if (!isFeishuHost(url.hostname)) {
    return undefined
  }
  const segments = url.pathname.split('/').filter(Boolean)
  const idx = segments.findIndex(segment => segment.toLowerCase() === 'folder')
  if (idx < 0) {
    return undefined
  }
  const token = segments[idx + 1]?.trim()
  return token || undefined
}

function isFeishuHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return host === 'feishu.cn' ||
    host.endsWith('.feishu.cn') ||
    host === 'larksuite.com' ||
    host.endsWith('.larksuite.com')
}

const KNOWN_SEGMENTS = new Set([
  'docx',
  'doc',
  'docs',
  'wiki',
  'sheets',
  'sheet',
  'base',
  'bitable',
  'file',
])

function segmentToResourceType(segment: string): FeishuResourceType {
  if (segment === 'docs') return 'doc'
  if (segment === 'sheets' || segment === 'sheet') return 'sheet'
  if (segment === 'base' || segment === 'bitable') return 'bitable'
  if (segment === 'docx' || segment === 'doc' || segment === 'wiki' || segment === 'file') {
    return segment
  }
  return 'unknown'
}

function readSheetIdFromHash(hash: string): string | undefined {
  const clean = hash.startsWith('#') ? hash.slice(1) : hash
  if (!clean) {
    return undefined
  }
  const params = new URLSearchParams(clean)
  return params.get('sheet') ?? params.get('sheet_id') ?? params.get('gid') ?? undefined
}
