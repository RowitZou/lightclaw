import path from 'node:path'
import { readFileSync } from 'node:fs'

import { loadConfigFile } from '../config-file.js'
import { pickWithLegacy } from '../config.js'
import { expandHomePath, lightclawHome } from '../paths.js'
import type { IdentitiesFile } from './types.js'
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

export function usersRoot(): string {
  return path.join(lightclawHome(), 'users')
}

export function userHome(canonicalUser: string): string {
  const dataRoot = userDataRoot(canonicalUser)
  if (dataRoot) {
    return dataRoot
  }
  return defaultUserHome(canonicalUser)
}

export function defaultUserHome(canonicalUser: string): string {
  return path.join(usersRoot(), sanitizePathSegment(canonicalUser))
}

export function userDataRoot(canonicalUser: string): string | undefined {
  let raw: string
  try {
    raw = readFileSync(identitiesPath(), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }
    throw error
  }
  const parsed = JSON.parse(raw) as IdentitiesFile
  const dataRoot = parsed[canonicalUser]?.dataRoot
  return typeof dataRoot === 'string' && dataRoot.trim()
    ? path.resolve(expandHomePath(dataRoot))
    : undefined
}

/**
 * Per-canonical-user persisted permission rules. Replaces the old in-memory
 * sessionRulesByUser map: when a user picks "以后都允许" / `[a]` the rule is
 * written here and survives daemon restarts. Loaded into the active
 * SessionContext for the active user, and
 * evaluated alongside cli / file / builtin sources by `evaluatePermission`.
 */
export function identityPermissionsPath(canonicalUser: string): string {
  return path.join(userHome(canonicalUser), 'permissions.json')
}

export function rlaunchMountsPath(canonicalUser: string): string {
  return path.join(userHome(canonicalUser), 'rlaunch-mounts.json')
}

export function userSecretsPath(canonicalUser: string): string {
  return path.join(userHome(canonicalUser), 'secrets.json')
}

export function userPreferencesPath(canonicalUser: string): string {
  return path.join(userHome(canonicalUser), 'preferences.json')
}

export function userSkillsRoot(canonicalUser: string): string {
  return path.join(userHome(canonicalUser), 'skills')
}

export function userTaskRunsRoot(canonicalUser: string): string {
  return path.join(userHome(canonicalUser), 'taskruns')
}

export function userSessionsRoot(canonicalUser: string): string {
  return path.join(userHome(canonicalUser), 'sessions')
}

export function userMemoryRoot(canonicalUser: string): string {
  return path.join(userHome(canonicalUser), 'memory')
}

export function userBackgroundTasksPath(canonicalUser: string): string {
  return path.join(userHome(canonicalUser), 'bg-tasks.json')
}

export function userCompletedBackgroundTasksPath(canonicalUser: string): string {
  return path.join(userHome(canonicalUser), 'bg-tasks-completed.jsonl')
}

export function userFeishuWorkspacePath(canonicalUser: string): string {
  return path.join(userHome(canonicalUser), 'feishu-workspace.json')
}

export function userFeishuUploadsPath(canonicalUser: string): string {
  return path.join(userHome(canonicalUser), 'feishu-uploads.json')
}

function configuredWorkspaceRoot(): string | undefined {
  const fileConfig = loadConfigFile()
  const fromFile = pickWithLegacy(
    'workspaceRoot',
    'paths.workspace',
    fileConfig.workspaceRoot,
    fileConfig.paths?.workspace,
  )
  const configured = process.env.LIGHTCLAW_WORKSPACE_ROOT ?? fromFile
  return configured ? path.resolve(expandHomePath(configured)) : undefined
}

export function workspaceRoot(): string {
  // Match resolveSessionsDir / memoryDir / apiLogsDir shape: env > new
  // `paths.workspace` > legacy top-level `workspaceRoot` > default user root.
  // Pre-fix this only read the legacy key, so 0.2.x configs that migrated to
  // the `paths.*` namespace silently fell back to the old default and the
  // rlaunch gpfs guard threw at first runtime acquire.
  return configuredWorkspaceRoot() ?? usersRoot()
}

export function workspaceFor(canonicalUser: string): string {
  const configured = configuredWorkspaceRoot()
  return configured
    ? path.join(configured, sanitizePathSegment(canonicalUser))
    : path.join(userHome(canonicalUser), 'workspace')
}

export function workspaceToGpfsMount(
  canonicalUser: string,
  rlaunchConfig: RlaunchGpfsMountConfig,
): { hostPath: string; mount: string } {
  const root = configuredWorkspaceRoot() ?? workspaceFor(canonicalUser)
  try {
    resolveGpfsMountRule(root, rlaunchConfig)
  } catch {
    const hostPrefixes = rlaunchConfig.gpfsMounts.map(rule => rule.hostPrefix)
    const example = hostPrefixes[0] ?? '<gpfs-host-prefix>'
    throw new Error(
      `RlaunchRuntime requires the workspace path under a configured gpfs host prefix ` +
      `(${hostPrefixes.join(', ')}); got "${root}". Set LIGHTCLAW_HOME or ` +
      `LIGHTCLAW_WORKSPACE_ROOT to a gpfs path, e.g. ${example}/<namespace>/<user>/lightclaw`,
    )
  }

  const hostPath = workspaceFor(canonicalUser)
  return {
    hostPath,
    mount: buildGpfsMountStringFromRules(hostPath, '/workspace', rlaunchConfig),
  }
}

export function sanitizePathSegment(input: string): string {
  const sanitized = input.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
  return sanitized || 'user'
}
