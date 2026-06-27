import { readFileSync } from 'node:fs'
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

// ── Per-user self-contained tree (`<home>/users/<canonical>/`) ──────────────
// Every per-user piece of state derives from `userHome()`. The previous
// by-type layout scattered one user across `identity/per-user/<u>/`,
// `sessions/<u>/`, `memory/<u>/`, and `workspaces/<u>/`; the inverted layout
// collects them under one portable root so a user is `tar users/<u>/`.
// Top-level `audit/`, `api-logs/`, `logs/` stay outside (cross-user
// observability) and `identity/{admin,identities,pending,rate-limits}.json`
// stay outside (global registries). `userHome()` is fixed at
// `<home>/users/<u>/` — the single anchor every per-user path derives from.

export function usersRoot(): string {
  return path.join(lightclawHome(), 'users')
}

export function userHome(canonicalUser: string): string {
  return path.join(usersRoot(), sanitizePathSegment(canonicalUser))
}

// Framework-managed runtime state the user never edits by hand lives under
// `users/<u>/state/`; only the user-facing `config.json` sits at the user
// root. Keeps the root self-documenting (config.json + content dirs) and
// gives `/export` one place to strip secrets / reset deployment bindings.
export function userStateRoot(canonicalUser: string): string {
  return path.join(userHome(canonicalUser), 'state')
}

export function userConfigPath(canonicalUser: string): string {
  return path.join(userHome(canonicalUser), 'config.json')
}

/**
 * Per-canonical-user persisted permission rules. Replaces the old in-memory
 * sessionRulesByUser map: when a user picks "以后都允许" / `[a]` the rule is
 * written here and survives daemon restarts. Loaded into the active
 * SessionContext for the active user, and
 * evaluated alongside cli / file / builtin sources by `evaluatePermission`.
 */
export function identityPermissionsPath(canonicalUser: string): string {
  return path.join(userStateRoot(canonicalUser), 'permissions.json')
}

export function rlaunchMountsPath(canonicalUser: string): string {
  return path.join(userStateRoot(canonicalUser), 'rlaunch-mounts.json')
}

export function rlaunchMountApprovalsPath(canonicalUser: string): string {
  return path.join(userStateRoot(canonicalUser), 'rlaunch-mount-approvals.json')
}

export function userSecretsPath(canonicalUser: string): string {
  return path.join(userStateRoot(canonicalUser), 'secrets.json')
}

export function userPreferencesPath(canonicalUser: string): string {
  return path.join(userStateRoot(canonicalUser), 'preferences.json')
}

export function userBackgroundTasksPath(canonicalUser: string): string {
  return path.join(userStateRoot(canonicalUser), 'bg-tasks.json')
}

export function userCompletedBackgroundTasksPath(canonicalUser: string): string {
  return path.join(userStateRoot(canonicalUser), 'bg-tasks-completed.jsonl')
}

export function userFeishuWorkspacePath(canonicalUser: string): string {
  return path.join(userStateRoot(canonicalUser), 'feishu-workspace.json')
}

export function userFeishuUploadsPath(canonicalUser: string): string {
  return path.join(userStateRoot(canonicalUser), 'feishu-uploads.json')
}

// ── Per-user content directories (`users/<u>/<dir>/`) ───────────────────────
// These hold user-owned content, not framework bookkeeping, so they sit at
// the user root beside `config.json` rather than under `state/`.

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

// ── Workspace ───────────────────────────────────────────────────────────────
// Default: `users/<u>/workspace` (travels with the user root). Admin escape
// hatch: `paths.workspace` / `LIGHTCLAW_WORKSPACE_ROOT` moves the workspace
// pool onto a bulk gpfs mount, in which case it stays `<configured>/<u>`.
// Per-user escape hatch (PR3): a user self-serves their own workspace dir via
// `/config set-workspace`, persisted as `.workspace` in `users/<u>/config.json`,
// which takes priority over the admin pool. Like the admin pool this is pure
// path derivation — the set-time validation gate + the runtime mount probe are
// the only guards; this resolver does NOT re-validate.

export function userWorkspaceOverride(canonicalUser: string): string | undefined {
  let raw: string
  try {
    raw = readFileSync(userConfigPath(canonicalUser), 'utf8')
  } catch {
    // ENOENT (no per-user config yet) or any read error → no override.
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // A corrupt config.json should not crash workspace resolution; the admin
    // pool / default still apply, and `/config set-workspace` rewrites the file.
    return undefined
  }
  const workspace = (parsed as { workspace?: unknown } | null)?.workspace
  if (typeof workspace === 'string' && workspace.trim().length > 0) {
    return path.resolve(expandHomePath(workspace))
  }
  return undefined
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
  return configuredWorkspaceRoot() ?? usersRoot()
}

export function workspaceFor(canonicalUser: string): string {
  const override = userWorkspaceOverride(canonicalUser)
  if (override) {
    return override
  }
  const configured = configuredWorkspaceRoot()
  return configured
    ? path.join(configured, sanitizePathSegment(canonicalUser))
    : path.join(userHome(canonicalUser), 'workspace')
}

export function workspaceToGpfsMount(
  canonicalUser: string,
  rlaunchConfig: RlaunchGpfsMountConfig,
): { hostPath: string; mount: string } {
  const hostPath = workspaceFor(canonicalUser)
  try {
    resolveGpfsMountRule(hostPath, rlaunchConfig)
  } catch {
    const hostPrefixes = rlaunchConfig.gpfsMounts.map(rule => rule.hostPrefix)
    const example = hostPrefixes[0] ?? '<gpfs-host-prefix>'
    throw new Error(
      `RlaunchRuntime requires the workspace path under a configured gpfs host prefix ` +
      `(${hostPrefixes.join(', ')}); got "${hostPath}". Set the user workspace or ` +
      `LIGHTCLAW_WORKSPACE_ROOT to a gpfs path, e.g. ${example}/<namespace>/<user>/lightclaw`,
    )
  }

  return {
    hostPath,
    mount: buildGpfsMountStringFromRules(hostPath, '/workspace', rlaunchConfig),
  }
}

export function sanitizePathSegment(input: string): string {
  const sanitized = input.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
  return sanitized || 'user'
}
