import type { PermissionRule } from './types.js'

export function getBuiltinDenyRules(): PermissionRule[] {
  // Path access is governed by runtime isolation: LocalRuntime is admin-only,
  // while DockerRuntime/RjobRuntime use their own environment boundary.
  return []
}
