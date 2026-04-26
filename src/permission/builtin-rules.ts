import type { PermissionRule } from './types.js'

export function getBuiltinDenyRules(): PermissionRule[] {
  // Phase 10 moved state protection into a hard workspace boundary in
  // permission/policy.ts. Keeping path rules here would also deny the
  // legitimate ~/.lightclaw/workspaces/<user> tree.
  return []
}
