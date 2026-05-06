import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { identityPermissionsPath } from '../identity/paths.js'
import { expandHomePath, lightclawHome } from '../paths.js'
import { formatRule, parseRule } from './rules.js'
import { getBuiltinDenyRules } from './builtin-rules.js'
import type { PermissionRule, PermissionRuleSource } from './types.js'

type PermissionFileShape = {
  allow?: string[]
  deny?: string[]
  ask?: string[]
}

function loadFile(pathname: string, source: PermissionRuleSource): PermissionRule[] {
  if (!existsSync(pathname)) {
    return []
  }

  let parsed: PermissionFileShape
  try {
    parsed = JSON.parse(readFileSync(pathname, 'utf8')) as PermissionFileShape
  } catch {
    return []
  }

  const rules: PermissionRule[] = []
  for (const text of parsed.allow ?? []) {
    try {
      rules.push({ source, behavior: 'allow', value: parseRule(text) })
    } catch {
      // Ignore invalid persisted rules so one typo does not break startup.
    }
  }

  for (const text of parsed.deny ?? []) {
    try {
      rules.push({ source, behavior: 'deny', value: parseRule(text) })
    } catch {
      // Ignore invalid persisted rules so one typo does not break startup.
    }
  }

  for (const text of parsed.ask ?? []) {
    try {
      rules.push({ source, behavior: 'ask', value: parseRule(text) })
    } catch {
      // Ignore invalid persisted rules so one typo does not break startup.
    }
  }

  return rules
}

export function loadFileRules(input: {
  cwd: string
  userPath?: string
  projectPath?: string
  localPath?: string
}): PermissionRule[] {
  const userPath = path.resolve(
    expandHomePath(input.userPath ?? path.join(lightclawHome(), 'permissions.json')),
  )
  const projectPath = path.resolve(
    input.cwd,
    expandHomePath(input.projectPath ?? path.join('.lightclaw', 'permissions.json')),
  )
  const localPath = path.resolve(
    input.cwd,
    expandHomePath(input.localPath ?? path.join('.lightclaw', 'permissions.local.json')),
  )

  return [
    ...loadFile(localPath, 'local'),
    ...loadFile(projectPath, 'project'),
    ...loadFile(userPath, 'user'),
    ...getBuiltinDenyRules(),
  ]
}

/**
 * Per-canonical-user identity rules. Loaded fresh into every resolved
 * SessionContext so daemon-internal mutations to the file (via
 * appendIdentityRules) become visible to the next turn without needing a
 * full restart.
 *
 * Returns [] for the synthetic terminal user (`undefined` canonical) — that
 * scope falls back to the file-rules layer (user / project / local).
 */
export function loadIdentityRules(canonicalUser: string | undefined): PermissionRule[] {
  if (!canonicalUser) {
    return []
  }
  return loadFile(identityPermissionsPath(canonicalUser), 'identity')
}

/**
 * Append rules to the user's identity permissions file. Atomic (tmp + rename
 * within the same directory so the swap is on the same filesystem). Dedup is
 * by formatRule(value) per behavior bucket — installing the same allow rule
 * twice is a no-op, so the coordinator's reevaluate-on-rule-change loop can
 * safely retry without duplicating entries.
 *
 * Concurrent appends inside one daemon are not expected (FeishuPermission-
 * Coordinator serializes per-owner via FIFO; terminal prompt is per-user
 * sequential), but the atomic rename keeps a partial failure from leaving a
 * half-written file.
 *
 * Throws if `canonicalUser` is undefined; terminal sessions without an
 * identity must fall back to the read-only file-rules layer.
 */
export function appendIdentityRules(input: {
  canonicalUser: string
  rules: PermissionRule[]
}): void {
  const { canonicalUser, rules } = input
  if (!canonicalUser) {
    throw new Error('appendIdentityRules: canonicalUser is required')
  }
  if (rules.length === 0) {
    return
  }
  const targetPath = identityPermissionsPath(canonicalUser)
  mkdirSync(path.dirname(targetPath), { recursive: true })

  let existing: PermissionFileShape = {}
  if (existsSync(targetPath)) {
    try {
      existing = JSON.parse(readFileSync(targetPath, 'utf8')) as PermissionFileShape
    } catch {
      // Corrupt file — start from empty rather than silently losing the
      // requested rule. Lost-history is a smaller blast than lost-grant
      // because the user can re-grant on the next prompt.
      existing = {}
    }
  }
  const allow = new Set(existing.allow ?? [])
  const deny = new Set(existing.deny ?? [])
  const ask = new Set(existing.ask ?? [])
  for (const rule of rules) {
    const text = formatRule(rule.value)
    if (rule.behavior === 'allow') allow.add(text)
    else if (rule.behavior === 'deny') deny.add(text)
    else ask.add(text)
  }
  const next: PermissionFileShape = {}
  if (allow.size > 0) next.allow = [...allow]
  if (deny.size > 0) next.deny = [...deny]
  if (ask.size > 0) next.ask = [...ask]

  const tmp = `${targetPath}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, targetPath)
}

/**
 * Remove a specific rule from the user's identity permissions file. Match is
 * by formatRule(value) within the same behavior bucket. No-op if the file or
 * the matching entry doesn't exist.
 */
export function removeIdentityRule(input: {
  canonicalUser: string
  rule: PermissionRule
}): void {
  const { canonicalUser, rule } = input
  const targetPath = identityPermissionsPath(canonicalUser)
  if (!existsSync(targetPath)) {
    return
  }
  let existing: PermissionFileShape
  try {
    existing = JSON.parse(readFileSync(targetPath, 'utf8')) as PermissionFileShape
  } catch {
    return
  }
  const text = formatRule(rule.value)
  const bucket: keyof PermissionFileShape =
    rule.behavior === 'allow' ? 'allow' : rule.behavior === 'deny' ? 'deny' : 'ask'
  const list = existing[bucket]
  if (!list) {
    return
  }
  const filtered = list.filter(item => item !== text)
  if (filtered.length === list.length) {
    return
  }
  if (filtered.length > 0) {
    existing[bucket] = filtered
  } else {
    delete existing[bucket]
  }
  const tmp = `${targetPath}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, `${JSON.stringify(existing, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, targetPath)
}

/**
 * Drop all identity rules for a user. Used by `/rules revoke all`.
 * No-op when the file does not exist.
 */
export function clearIdentityRules(canonicalUser: string): void {
  const targetPath = identityPermissionsPath(canonicalUser)
  if (!existsSync(targetPath)) {
    return
  }
  const tmp = `${targetPath}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, '{}\n', { mode: 0o600 })
  renameSync(tmp, targetPath)
}
