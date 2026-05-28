import path from 'node:path'

import { loadConfigFile } from '../config-file.js'
import { pickWithLegacy } from '../config.js'
import { expandHomePath, lightclawHome } from '../paths.js'
import {
  buildGpfsMountStringFromRules,
  resolveGpfsMountRule,
  type RlaunchGpfsMountConfig,
} from '../runtime/gpfs-mount-rules.js'

export function identityRoot(): string {
  return path.join(lightclawHome(), 'identity')
}

export function adminPath(): string {
  return path.join(identityRoot(), 'admin.json')
}

export function identitiesPath(): string {
  return path.join(identityRoot(), 'identities.json')
}

export function pendingPath(): string {
  return path.join(identityRoot(), 'pending.json')
}

export function rateLimitsPath(): string {
  return path.join(identityRoot(), 'rate-limits.json')
}

/**
 * Per-canonical-user persisted permission rules. Replaces the old in-memory
 * sessionRulesByUser map: when a user picks "以后都允许" / `[a]` the rule is
 * written here and survives daemon restarts. Loaded into the active
 * SessionContext for the active user, and
 * evaluated alongside cli / file / builtin sources by `evaluatePermission`.
 */
export function identityPermissionsPath(canonicalUser: string): string {
  return path.join(
    identityRoot(),
    'per-user',
    sanitizePathSegment(canonicalUser),
    'permissions.json',
  )
}

export function rlaunchMountsPath(canonicalUser: string): string {
  return path.join(
    identityRoot(),
    'per-user',
    sanitizePathSegment(canonicalUser),
    'rlaunch-mounts.json',
  )
}

export function userSecretsPath(canonicalUser: string): string {
  return path.join(
    identityRoot(),
    'per-user',
    sanitizePathSegment(canonicalUser),
    'secrets.json',
  )
}

export function userSkillsRoot(canonicalUser: string): string {
  return path.join(
    identityRoot(),
    'per-user',
    sanitizePathSegment(canonicalUser),
    'skills',
  )
}

export function workspaceRoot(): string {
  const fileConfig = loadConfigFile()
  // Match resolveSessionsDir / memoryDir / apiLogsDir shape: env > new
  // `paths.workspace` > legacy top-level `workspaceRoot` > default. Pre-fix
  // this only read the legacy key, so 0.2.x configs that migrated to the
  // `paths.*` namespace silently fell back to `<home>/workspaces` and the
  // rlaunch gpfs guard threw at first runtime acquire.
  const fromFile = pickWithLegacy(
    'workspaceRoot',
    'paths.workspace',
    fileConfig.workspaceRoot,
    fileConfig.paths?.workspace,
  )
  const configured =
    process.env.LIGHTCLAW_WORKSPACE_ROOT ??
    fromFile ??
    path.join(lightclawHome(), 'workspaces')
  return path.resolve(expandHomePath(configured))
}

export function workspaceFor(canonicalUser: string): string {
  return path.join(workspaceRoot(), sanitizePathSegment(canonicalUser))
}

export function workspaceToGpfsMount(
  canonicalUser: string,
  rlaunchConfig: RlaunchGpfsMountConfig,
): { hostPath: string; mount: string } {
  const root = workspaceRoot()
  try {
    resolveGpfsMountRule(root, rlaunchConfig)
  } catch {
    const hostPrefixes = rlaunchConfig.gpfsMounts.map(rule => rule.hostPrefix)
    const example = hostPrefixes[0] ?? '<gpfs-host-prefix>'
    throw new Error(
      `RlaunchRuntime requires LIGHTCLAW_WORKSPACE_ROOT under a configured gpfs host prefix ` +
      `(${hostPrefixes.join(', ')}); got "${root}". Set LIGHTCLAW_WORKSPACE_ROOT to a gpfs path, e.g. ` +
      `${example}/<namespace>/<user>/lightclaw-workspaces`,
    )
  }

  const hostPath = path.join(root, sanitizePathSegment(canonicalUser))
  return {
    hostPath,
    mount: buildGpfsMountStringFromRules(hostPath, '/workspace', rlaunchConfig),
  }
}

export function sanitizePathSegment(input: string): string {
  const sanitized = input.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
  return sanitized || 'user'
}
