import { LOCALES, type LocaleKey } from './locales.js'

export type Lang = 'cn' | 'en'

export const SUPPORTED_LANGS: ReadonlyArray<Lang> = ['cn', 'en']

let currentLang: Lang = 'cn'

export function getLang(): Lang {
  return currentLang
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
  const table = (LOCALES[currentLang] ?? LOCALES.en) as Record<string, string>
  const fallback = LOCALES.en as Record<string, string>
  let raw: string = table[key] ?? fallback[key] ?? String(key)
  if (args) {
    for (const [k, v] of Object.entries(args)) {
      raw = raw.split(`{${k}}`).join(String(v))
    }
  }
  return raw
}
