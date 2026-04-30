import path from 'node:path'

import { loadConfigFile } from '../config-file.js'
import { expandHomePath, lightclawHome } from '../paths.js'

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

export function workspaceRoot(): string {
  const fileConfig = loadConfigFile()
  const configured =
    process.env.LIGHTCLAW_WORKSPACE_ROOT ??
    fileConfig.workspaceRoot ??
    path.join(lightclawHome(), 'workspaces')
  return path.resolve(expandHomePath(configured))
}

export function workspaceFor(canonicalUser: string): string {
  return path.join(workspaceRoot(), sanitizePathSegment(canonicalUser))
}

export function sanitizePathSegment(input: string): string {
  const sanitized = input.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
  return sanitized || 'user'
}
