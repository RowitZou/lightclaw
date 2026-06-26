import { getCurrentSessionContext } from '../session-context.js'
import { LOCALES, type LocaleKey } from './locales.js'

export type Lang = 'cn' | 'en'

export const SUPPORTED_LANGS: ReadonlyArray<Lang> = ['cn', 'en']

// Module-global FALLBACK language for contexts with no active session — startup
// banner, infra logging, terminal bootstrap — set once by init.ts. It is
// intentionally NOT the per-user language: a single daemon serves many users
// concurrently (one cn, one en) on the same event loop, so the live language
// must come from the per-session config, not this shared global. See getLang().
let currentLang: Lang = 'cn'

/**
 * The active language for the CURRENT call. Resolved from the ambient
 * `SessionContext.config.lang` (the per-user resolved snapshot, re-read from
 * disk on every inbound message by `resetSessionContext`), so a user's
 * `/config lang set` is next-message-effective exactly like `/config model` /
 * `/config mode`. Falls back to the module-global `currentLang` outside any
 * session scope.
 *
 * Why ALS and not `setLang(sessionLang)` per turn: `t()` is synchronous but a
 * turn does many `await`s, and concurrent users' turns interleave on one event
 * loop. A shared mutable global would be overwritten by whichever turn ran most
 * recently — user A's `t()` after an await would render in user B's language.
 * Reading from the ALS-scoped session config is race-free by construction.
 */
export function getLang(): Lang {
  const sessionLang = getCurrentSessionContext()?.config?.lang
  return sessionLang === 'cn' || sessionLang === 'en' ? sessionLang : currentLang
}

export function setLang(lang: Lang): void {
  currentLang = lang
}

export function parseLang(input: string | undefined): Lang | undefined {
  if (!input) return undefined
  const v = input.trim().toLowerCase()
  if (v === 'cn' || v === 'zh' || v === 'zh-cn' || v === 'chinese') return 'cn'
  if (v === 'en' || v === 'en-us' || v === 'english') return 'en'
  return undefined
}

/**
 * Lookup the message for `key` in the active locale, falling back to en, then
 * to the key itself (so a missing translation surfaces visibly rather than
 * silently producing `undefined`). `args` performs `{name}` placeholder
 * substitution on the result.
 *
 * Centralized here so callers don't reach into the LOCALES table directly —
 * keeps the contract single-pointed and lets us add memoization, pluralization,
 * etc. later without touching every call site.
 */
export function t(key: LocaleKey, args?: Record<string, string | number>): string {
  const table = (LOCALES[getLang()] ?? LOCALES.en) as Record<string, string>
  const fallback = LOCALES.en as Record<string, string>
  let raw: string = table[key] ?? fallback[key] ?? String(key)
  if (args) {
    for (const [k, v] of Object.entries(args)) {
      raw = raw.split(`{${k}}`).join(String(v))
    }
  }
  return raw
}
