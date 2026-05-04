import type { PermissionMode } from '../permission/types.js'

/**
 * Channel-friendly aliases for permission modes. Internal enum is kept
 * (permissions.json schema, ceiling rank logic) so existing data and tests
 * are untouched; the aliases are just a UX layer at command-input parse and
 * command-output rendering time.
 *
 *   read  ↔ plan                only safe (read-only) tools
 *   ask   ↔ default             writes / executes prompt for confirmation
 *   auto  ↔ acceptEdits         writes auto-allowed; executes prompt
 *   yolo  ↔ bypassPermissions   everything runs (use with caution)
 */
export const ALIAS_TO_MODE: Record<string, PermissionMode> = {
  read: 'plan',
  ask: 'default',
  auto: 'acceptEdits',
  yolo: 'bypassPermissions',
}

export const MODE_TO_ALIAS: Record<PermissionMode, string> = {
  plan: 'read',
  default: 'ask',
  acceptEdits: 'auto',
  bypassPermissions: 'yolo',
}

export const MODE_DESCRIPTIONS: Record<string, string> = {
  read: '只读，不动文件',
  ask: '写操作前问我',
  auto: '自动改文件，执行类还问',
  yolo: '全放行（用前确认作用域）',
}

export const MODE_ALIASES = Object.keys(ALIAS_TO_MODE) as ReadonlyArray<string>

/**
 * Parse a user-typed mode (alias or internal enum, case-insensitive after trim).
 * Returns null on no match; callers render the canonical error string.
 */
export function parseMode(input: string): PermissionMode | null {
  const trimmed = input.trim().toLowerCase()
  if (!trimmed) return null
  if (trimmed in ALIAS_TO_MODE) return ALIAS_TO_MODE[trimmed]!
  // Accept internal enum too — admin scripts and old habits keep working,
  // /mode acceptEdits still resolves. This is intentionally permissive
  // because the alias layer is UX, not a hard schema gate.
  const internal = ['plan', 'default', 'acceptEdits', 'bypassPermissions'] as const
  for (const m of internal) {
    if (m.toLowerCase() === trimmed) return m
  }
  return null
}

export function modeToAlias(mode: PermissionMode): string {
  return MODE_TO_ALIAS[mode] ?? mode
}
