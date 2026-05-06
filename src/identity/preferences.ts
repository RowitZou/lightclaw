import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import type { PermissionMode } from '../permission/types.js'
import { identityRoot, sanitizePathSegment } from './paths.js'

/**
 * Per-canonical-user runtime preferences (`permissionMode`, `model`). Lives
 * next to `permissions.json` in `<lightclawHome>/identity/per-user/<canonical>/`.
 *
 * The motivation is cross-surface alignment: the same identity can drive a
 * terminal session and a Feishu session simultaneously (each owns its own
 * sessionId / meta.json). Storing mode + model in session meta meant a
 * `/mode auto` in the terminal never reached the Feishu session, and vice
 * versa. Preferences are read into every resolved SessionContext with
 * priority `prefs > caller input > config default`, so a user-driven change
 * in either surface is the source of truth for the next turn.
 */

export type IdentityPreferences = {
  permissionMode?: PermissionMode
  model?: string
}

const VALID_MODES: ReadonlySet<PermissionMode> = new Set([
  'default',
  'plan',
  'acceptEdits',
  'bypassPermissions',
])

export function identityPreferencesPath(canonicalUser: string): string {
  return path.join(
    identityRoot(),
    'per-user',
    sanitizePathSegment(canonicalUser),
    'preferences.json',
  )
}

/**
 * Read the user's persisted preferences. Returns `{}` for terminal sessions
 * without a paired identity, missing files, or unreadable / corrupt JSON —
 * mirroring the permission-storage policy where lost-prefs is a smaller
 * blast than failing to start. Unknown / invalid mode strings are dropped
 * silently so a partial corruption does not poison subsequent reads.
 */
export function loadIdentityPreferences(
  canonicalUser: string | undefined,
): IdentityPreferences {
  if (!canonicalUser) {
    return {}
  }
  const targetPath = identityPreferencesPath(canonicalUser)
  if (!existsSync(targetPath)) {
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(targetPath, 'utf8'))
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== 'object') {
    return {}
  }
  const raw = parsed as Record<string, unknown>
  const out: IdentityPreferences = {}
  if (typeof raw.permissionMode === 'string' && VALID_MODES.has(raw.permissionMode as PermissionMode)) {
    out.permissionMode = raw.permissionMode as PermissionMode
  }
  if (typeof raw.model === 'string' && raw.model.length > 0) {
    out.model = raw.model
  }
  return out
}

/**
 * Set a single preference field for the user. Atomic via tmp + rename within
 * the same directory. Other fields in the file are preserved (read-modify-
 * write on the existing JSON object, so concurrent writes from the same
 * daemon can coexist as long as they touch different keys).
 *
 * Throws if `canonicalUser` is empty — the caller must have a paired identity
 * to persist preferences. Terminal sessions without a paired identity have no
 * stable per-user key to write under, so the slash handler is responsible for
 * gating that case.
 */
export function setIdentityPreference<K extends keyof IdentityPreferences>(input: {
  canonicalUser: string
  key: K
  value: IdentityPreferences[K]
}): void {
  const { canonicalUser, key, value } = input
  if (!canonicalUser) {
    throw new Error('setIdentityPreference: canonicalUser is required')
  }
  const targetPath = identityPreferencesPath(canonicalUser)
  mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 })

  let existing: IdentityPreferences = {}
  if (existsSync(targetPath)) {
    try {
      const parsed = JSON.parse(readFileSync(targetPath, 'utf8')) as unknown
      if (parsed && typeof parsed === 'object') {
        existing = { ...(parsed as IdentityPreferences) }
      }
    } catch {
      existing = {}
    }
  }
  if (value === undefined) {
    delete existing[key]
  } else {
    existing[key] = value
  }

  const tmp = `${targetPath}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, `${JSON.stringify(existing, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, targetPath)
}
