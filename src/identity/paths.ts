import { homedir } from 'node:os'
import path from 'node:path'

export function identityRoot(): string {
  return path.join(homedir(), '.lightclaw', 'identity')
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
  return path.join(homedir(), '.lightclaw', 'workspaces')
}

export function workspaceFor(canonicalUser: string): string {
  return path.join(workspaceRoot(), sanitizePathSegment(canonicalUser))
}

export function sanitizePathSegment(input: string): string {
  const sanitized = input.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
  return sanitized || 'user'
}
