/**
 * Download filename derivation + binary-vs-text content-type classification
 * for daemon-side WebFetch. Direct TS port of
 * `scripts/sandbox-helpers/webfetch.py:75-199` (which Phase C Iter C0
 * deletes). Logic byte-equivalent so the helper-era downloads/<filename>
 * naming convention survives the daemon migration unchanged — agents that
 * cached a path-as-handle across the migration keep working.
 *
 * Why mime-derived extension is authoritative: URL paths like
 * `arxiv.org/pdf/2509.25721` look like `<basename>.<ext>` to a naive
 * `path.extname` but `.25721` is a paper version, not a file extension.
 * Trusting the response `Content-Type` is the only reliable signal.
 */

import { randomBytes } from 'node:crypto'
import path from 'node:path/posix'

/** Mime → file extension. Mirrors Claude Code's
 *  `mcpOutputStorage.extensionForMimeType` mapping (shared vocabulary keeps
 *  cross-tool behavior predictable). Only consulted on the binary path;
 *  text content types never reach this table. */
const MIME_TO_EXT: Readonly<Record<string, string>> = {
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/x-zip-compressed': 'zip',
  'application/x-tar': 'tar',
  'application/gzip': 'gz',
  'application/x-gzip': 'gz',
  'application/x-bzip2': 'bz2',
  'application/x-7z-compressed': '7z',
  'application/x-rar-compressed': 'rar',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/msword': 'doc',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/octet-stream': 'bin',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/x-wav': 'wav',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  // Note: image/svg+xml is text (xml-shaped) and goes through textBodyToMarkdown,
  // not here.
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
}

/** Strip Content-Type parameters and lowercase the bare media type. */
function normalizeMime(mime: string): string {
  return (mime.split(';', 1)[0] ?? '').trim().toLowerCase()
}

/**
 * Classify a response Content-Type as text (utf-8 decode + markdown extract)
 * vs binary (raw bytes to disk). Inverted match of Claude Code's
 * `isBinaryContentType` in `mcpOutputStorage`.
 *
 * Empty / missing header → text (servers that mean to serve binary almost
 * always set the header; falling through to utf-8 decode is the safer
 * default). Concrete rules:
 *   - `text/*`        → text
 *   - `application/json` or `<anything>+json`     → text
 *   - `application/xml`  or `<anything>+xml`      → text
 *   - `application/javascript`                    → text
 *   - `application/x-www-form-urlencoded`         → text
 *   - everything else (pdf, images, office, archives, audio/video,
 *     octet-stream) → binary
 */
export function isTextContentType(mime: string): boolean {
  if (!mime) return true
  const mt = normalizeMime(mime)
  if (!mt) return true
  if (mt.startsWith('text/')) return true
  if (mt === 'application/json' || mt.endsWith('+json')) return true
  if (mt === 'application/xml' || mt.endsWith('+xml')) return true
  if (mt.startsWith('application/javascript')) return true
  if (mt === 'application/x-www-form-urlencoded') return true
  return false
}

/** Inverse of {@link isTextContentType} — the call sites in
 *  `web-fetch.ts` read more naturally with the binary form. */
export function isBinaryContentType(mime: string): boolean {
  return !isTextContentType(mime)
}

/** Mime → ext lookup with `bin` fallback. */
export function extForMime(mime: string): string {
  if (!mime) return 'bin'
  const mt = normalizeMime(mime)
  return MIME_TO_EXT[mt] ?? 'bin'
}

/** Match the Python `_FILENAME_SAFE_RE = re.compile(r"[^A-Za-z0-9._-]")`.
 *  Anything outside that class becomes a hyphen during sanitization. */
const FILENAME_UNSAFE = /[^A-Za-z0-9._-]/g

/** Strip leading/trailing `-`, `_`, `.` (used to clean up sanitization
 *  artifacts before length-capping). Matches Python's `.strip("-_.")`. */
function stripTrimChars(s: string): string {
  return s.replace(/^[-_.]+|[-_.]+$/g, '')
}

/**
 * Build a deterministic-but-non-overwriting download filename for a binary
 * response. The mime-derived extension is authoritative; URL basenames
 * that already carry the matching extension get it stripped to avoid
 * doubled `sample.pdf-<rand>.pdf` — comparison is case-insensitive on a
 * copy, original casing of `name_part` preserved.
 *
 * A 6-char hex random suffix is always appended so repeated fetches of
 * the same URL never silently overwrite a previous download (cheaper than
 * stat + retry, and downstream tools that already grabbed the path keep
 * working). Name part is capped at 64 chars to keep filesystem paths
 * sane on tight worker workspaces.
 *
 * Examples (mime-derived ext in parens):
 *   - (`pdf`) `https://arxiv.org/pdf/2509.25721` → `2509-25721-<6hex>.pdf`
 *     (the `.25721` is sanitized to `-25721` by FILENAME_UNSAFE because
 *     the URL's basename `2509.25721` has no real extension; mime tells
 *     us it's a PDF and that wins)
 *   - (`jpg`) `https://example.com/foo.jpg` → `foo-<6hex>.jpg`
 *     (`.jpg` matched the mime-derived suffix and got stripped to avoid
 *     `foo.jpg-<rand>.jpg`)
 *   - (`bin`) `https://example.com/` (empty basename) → `webfetch-<6hex>.bin`
 */
export function deriveFilename(url: string, mime: string): string {
  let raw = ''
  try {
    const parsed = new URL(url)
    raw = path.basename(parsed.pathname || '')
  } catch {
    // Malformed URL → fall back to the generic "webfetch" prefix; caller
    // is expected to have validated URL earlier, but defensive nonetheless.
  }
  raw = raw.trim()

  const targetExt = extForMime(mime)
  const suffix = '.' + targetExt
  const namePart = raw.toLowerCase().endsWith(suffix)
    ? raw.slice(0, raw.length - suffix.length)
    : raw

  let cleaned = stripTrimChars(namePart.replace(FILENAME_UNSAFE, '-')).slice(0, 64)
  if (!cleaned) cleaned = 'webfetch'

  // 3 bytes = 6 hex chars, matches Python's `secrets.token_hex(3)`.
  const rand = randomBytes(3).toString('hex')
  return `${cleaned}-${rand}.${targetExt}`
}
