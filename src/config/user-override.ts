import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

import type { LightClawConfig } from '../config.js'
import { userConfigPath } from '../identity/paths.js'
import { loadIdentityPreferences } from '../identity/preferences.js'

/**
 * Per-user config merge layer (PR4). Lives at `users/<canonical>/config.json`
 * alongside PR3's `.workspace` key. The schema is restricted to the handful
 * of fields a user may override; `.strict()` rejects any admin-only field so a
 * user config.json can never express deployment-level settings (endpoints,
 * runtime, channels, ...).
 *
 * The heart of this module is `resolveUserConfig`, which folds the user's
 * overrides onto the admin base with **UNION semantics**: the admin model /
 * endpoint registry is always preserved (BYO registries are a later PR), only
 * the user-overridable scalars (`defaultModel`, `lang`) are merged. The
 * `defaultModel` resolution chain is the correctness-critical part — see the
 * function body.
 */

const UserConfigOverrideSchema = z
  .object({
    // The user's chosen model alias. Must resolve against the (admin) model
    // registry to actually take effect; an unknown value falls back to the
    // admin default in resolveUserConfig rather than erroring.
    defaultModel: z.string().min(1).optional(),
    lang: z.enum(['cn', 'en']).optional(),
    // PR3's field — kept round-tripping. Workspace resolution itself lives in
    // identity/paths.ts:userWorkspaceOverride; it is declared here only so the
    // strict schema does not reject a config.json that carries it.
    workspace: z.string().min(1).optional(),
    // Declared for schema completeness. /mode is NOT moved to config.json in
    // this PR — permissionMode keeps living in preferences.json with its
    // live-read semantics. resolveUserConfig may carry it through but must not
    // change how /mode persists or how permission/index reads it.
    permissionMode: z.enum(['default', 'plan', 'acceptEdits', 'bypassPermissions']).optional(),
  })
  .strict()

export type UserConfigOverride = z.infer<typeof UserConfigOverrideSchema>

/**
 * Read + safe-parse the per-user config.json. Missing file or any parse /
 * validation failure degrades to `{}` (mirrors the workspace / preferences
 * fail-soft policy: a corrupt user config must never crash model resolution —
 * the admin default still applies, and `/config` / `/model` rewrite the file).
 */
export function loadUserConfigOverride(canonicalUser: string): UserConfigOverride {
  const target = userConfigPath(canonicalUser)
  if (!existsSync(target)) {
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(target, 'utf8'))
  } catch {
    return {}
  }
  const result = UserConfigOverrideSchema.safeParse(parsed)
  return result.success ? result.data : {}
}

/**
 * Fold a user's overrides onto the admin base config and return a resolved
 * snapshot. UNION semantics — the admin registry is never replaced:
 *
 *   - `endpoints` / `models` stay the admin base's, UNCHANGED. (Swapping in a
 *     user-owned registry was qm's P0 bug; BYO registries are a later PR.)
 *   - `lang` = override.lang ?? base.lang.
 *   - `defaultModel` follows a three-step chain (the heart of this PR):
 *       1. user model (config.json `defaultModel`, else back-compat
 *          preferences.json `model`) — used iff it exists in the registry;
 *       2. else the admin `base.defaultModel` — used iff it exists in the
 *          registry (this is what makes zero-config work);
 *       3. else `''` — a valid graceful "no model configured" state, NOT an
 *          error. Callers gate on empty BEFORE provider resolution can throw.
 *
 * `canonical === undefined` returns the base unchanged (terminal anon / no
 * identity to key under).
 */
export function resolveUserConfig(
  canonical: string | undefined,
  base: LightClawConfig,
): LightClawConfig {
  if (canonical === undefined) {
    return base
  }
  const override = loadUserConfigOverride(canonical)
  // endpoints + models are the admin base's, untouched.
  const resolved: LightClawConfig = {
    ...base,
    lang: override.lang ?? base.lang,
  }
  // config.json's defaultModel wins; back-compat falls through to the legacy
  // preferences.json `model` field when config.json has none.
  const userModel =
    override.defaultModel ?? loadIdentityPreferences(canonical).model

  if (userModel && resolved.models[userModel]) {
    resolved.defaultModel = userModel
  } else if (base.defaultModel && resolved.models[base.defaultModel]) {
    resolved.defaultModel = base.defaultModel
  } else {
    resolved.defaultModel = ''
  }
  return resolved
}

// ── Single config.json writer ───────────────────────────────────────────────
// PR3 originally inlined readUserConfig / writeUserConfig in commands/config.ts.
// Consolidated here so there is exactly one writer of users/<u>/config.json;
// commands/config.ts imports these. Raw / key-preserving / atomic 0600 — we
// intentionally do NOT round-trip through the strict schema on write so any key
// we do not own (a future PR's field) survives a `/model` / `/config` edit.

export function readUserConfig(canonicalUser: string): Record<string, unknown> {
  let raw: string
  try {
    raw = readFileSync(userConfigPath(canonicalUser), 'utf8')
  } catch {
    return {}
  }
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export function writeUserConfig(canonicalUser: string, data: Record<string, unknown>): void {
  const filePath = userConfigPath(canonicalUser)
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const tmp = `${filePath}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  // Atomic replace so a crash mid-write never leaves a half-written config.json.
  renameSync(tmp, filePath)
}

/**
 * Update a single field in `users/<u>/config.json`, preserving every other
 * key (read-modify-write on the raw object). `value === undefined` deletes the
 * key. Atomic 0600 via writeUserConfig.
 */
export function setUserConfigField(
  canonicalUser: string,
  key: keyof UserConfigOverride,
  value: UserConfigOverride[keyof UserConfigOverride] | undefined,
): void {
  const merged = readUserConfig(canonicalUser)
  if (value === undefined) {
    delete merged[key]
  } else {
    merged[key] = value
  }
  writeUserConfig(canonicalUser, merged)
}
