export type BaseUrlValidation =
  | { ok: true; value: string }
  | { ok: false; reason: 'invalid' | 'protocol'; nonAscii: boolean }

/**
 * Validate an endpoint `--base-url` at input time so a malformed value is caught
 * with an actionable message instead of surfacing later as a bare `Invalid URL`
 * thrown deep in the connectivity probe (the 2026-06-26 full-width-colon dogfood:
 * a Chinese-IME `：` produced a thrown `new URL()` error with no hint about which
 * flag or character was wrong).
 *
 * Unlike `normalizeProxyUrl`, a base URL legitimately carries a path (`/v1`), so
 * this only requires a parseable absolute http(s) URL — it does NOT reject path /
 * query / hash. The value is trimmed (leading/trailing whitespace is a common
 * paste artifact); `nonAscii` flags a likely full-width / non-ASCII character so
 * the caller can append a "switch to half-width" hint.
 */
export function validateBaseUrl(raw: string): BaseUrlValidation {
  const trimmed = raw.trim()
  const nonAscii = /[^\x00-\x7F]/.test(trimmed)
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return { ok: false, reason: 'invalid', nonAscii }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'protocol', nonAscii }
  }
  return { ok: true, value: trimmed }
}
