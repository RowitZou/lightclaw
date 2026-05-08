import { isValidIdentityName } from './store.js'

export type CanonicalDeriveInput = {
  name?: string
  email?: string
  openId: string
  userId?: string
}

export function deriveCanonicalName(input: CanonicalDeriveInput): string {
  const openIdSuffix = sanitizeSuffix(input.openId.slice(-8).toLowerCase())
  const suffix = sanitizeSuffix((input.userId ?? openIdSuffix).toLowerCase()) || openIdSuffix
  const base = deriveBase(input.name, input.email, openIdSuffix)
  const baseMaxLen = Math.max(1, 32 - suffix.length - 1)
  const candidate = `${base.slice(0, baseMaxLen)}_${suffix}`
  if (isValidIdentityName(candidate)) {
    return candidate
  }
  return `user_${openIdSuffix}`
}

function deriveBase(name: string | undefined, email: string | undefined, openIdSuffix: string): string {
  const nameSlug = asciiSlug(name)
  if (nameSlug) {
    return nameSlug
  }
  const emailPrefix = email?.split('@')[0]
  const emailSlug = asciiSlug(emailPrefix)
  if (emailSlug) {
    return emailSlug
  }
  return `user_${openIdSuffix}`
}

function asciiSlug(value: string | undefined): string | null {
  const slug = value?.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() ?? ''
  return slug.length >= 2 && /^[a-z]/.test(slug) ? slug : null
}

function sanitizeSuffix(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
}
