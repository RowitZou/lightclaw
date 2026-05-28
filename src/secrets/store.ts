import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { safeWriteJson } from '../atomic-write.js'
import { userSecretsPath } from '../identity/paths.js'

export type UserSecret = {
  value: string
  enabled: boolean
  updatedAt: string
}

export type UserSecretMetadata = {
  name: string
  enabled: boolean
  length: number
  updatedAt: string
  masked: string
}

type SecretsFile = {
  version?: number
  secrets?: Record<string, unknown>
}

const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/
const RESERVED_SECRET_NAME_RE = /^(?:PATH|HOME|USER|LIGHTCLAW_.*|HTTP_PROXY|HTTPS_PROXY|NO_PROXY)$/
const EMPTY_SECRETS: ReadonlyMap<string, string> = new Map<string, string>()

export function validateSecretName(name: string): string {
  const trimmed = name.trim()
  if (!SECRET_NAME_RE.test(trimmed)) {
    throw new Error('secret name must match ^[A-Z][A-Z0-9_]{0,63}$')
  }
  if (RESERVED_SECRET_NAME_RE.test(trimmed)) {
    throw new Error(`secret name ${trimmed} is reserved and cannot be injected`)
  }
  return trimmed
}

function validateSecretValue(value: string): void {
  if (value.includes('\0')) {
    throw new Error('secret value must not contain NUL bytes')
  }
}

export function loadUserSecrets(canonicalUser: string): Record<string, UserSecret> {
  const target = userSecretsPath(canonicalUser)
  if (!existsSync(target)) return {}
  let parsed: SecretsFile
  try {
    parsed = JSON.parse(readFileSync(target, 'utf8')) as SecretsFile
  } catch {
    return {}
  }
  if (!parsed.secrets || typeof parsed.secrets !== 'object' || Array.isArray(parsed.secrets)) {
    return {}
  }

  const result: Record<string, UserSecret> = {}
  for (const [rawName, rawEntry] of Object.entries(parsed.secrets)) {
    try {
      const name = validateSecretName(rawName)
      if (!rawEntry || typeof rawEntry !== 'object') continue
      const entry = rawEntry as Record<string, unknown>
      if (typeof entry.value !== 'string') continue
      result[name] = {
        value: entry.value,
        enabled: entry.enabled === true,
        updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : '',
      }
    } catch {
      continue
    }
  }
  return result
}

function saveUserSecrets(
  canonicalUser: string,
  secrets: Readonly<Record<string, UserSecret>>,
): void {
  const target = userSecretsPath(canonicalUser)
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  const normalized: Record<string, UserSecret> = {}
  for (const [rawName, entry] of Object.entries(secrets).sort(([a], [b]) => a.localeCompare(b))) {
    normalized[validateSecretName(rawName)] = entry
  }
  safeWriteJson(target, { version: 1, secrets: normalized }, { mode: 0o600 })
}

export function setUserSecret(
  canonicalUser: string,
  rawName: string,
  value: string,
): { name: string; replaced: boolean; metadata: UserSecretMetadata } {
  const name = validateSecretName(rawName)
  validateSecretValue(value)
  const current = loadUserSecrets(canonicalUser)
  const previous = current[name]
  current[name] = {
    value,
    enabled: previous?.enabled ?? false,
    updatedAt: new Date().toISOString(),
  }
  saveUserSecrets(canonicalUser, current)
  return { name, replaced: Boolean(previous), metadata: secretMetadata(name, current[name]) }
}

export function setEnabled(
  canonicalUser: string,
  rawName: string,
  enabled: boolean,
): { name: string; stored: boolean; enabled: boolean } {
  const name = validateSecretName(rawName)
  const current = loadUserSecrets(canonicalUser)
  if (!current[name]) {
    return { name, stored: false, enabled: false }
  }
  if (current[name].enabled !== enabled) {
    current[name] = { ...current[name], enabled }
    saveUserSecrets(canonicalUser, current)
  }
  return { name, stored: true, enabled }
}

export function removeUserSecret(
  canonicalUser: string,
  rawName: string,
): { name: string; removed: boolean } {
  const name = validateSecretName(rawName)
  const current = loadUserSecrets(canonicalUser)
  const removed = Boolean(current[name])
  if (removed) {
    delete current[name]
    saveUserSecrets(canonicalUser, current)
  }
  return { name, removed }
}

export function loadEnabledSecrets(canonicalUser: string): ReadonlyMap<string, string> {
  const all = loadUserSecrets(canonicalUser)
  const result = new Map<string, string>()
  for (const name of Object.keys(all).sort()) {
    if (all[name].enabled) result.set(name, all[name].value)
  }
  return result.size === 0 ? EMPTY_SECRETS : result
}

export function listUserSecretMetadata(canonicalUser: string): UserSecretMetadata[] {
  return Object.entries(loadUserSecrets(canonicalUser))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, entry]) => secretMetadata(name, entry))
}

export function maskSecret(value: string): string {
  if (value.length <= 4) return '****'
  return `${'*'.repeat(Math.min(8, value.length - 4))}${value.slice(-4)}`
}

function secretMetadata(name: string, entry: UserSecret): UserSecretMetadata {
  return {
    name,
    enabled: entry.enabled,
    length: entry.value.length,
    updatedAt: entry.updatedAt,
    masked: maskSecret(entry.value),
  }
}
