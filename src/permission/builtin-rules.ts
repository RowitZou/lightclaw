import { parseRule } from './rules.js'
import type { PermissionRule } from './types.js'

// matchPath expands `~` and `~/...` for both pattern and input
// (see permission/matchers.ts:normalizePatternPath), so the literal-tilde
// form alone covers any actual file path that resolves under $HOME/.lightclaw.
// Pre-fix code emitted both forms; the absolute-path duplicate was redundant.
export function getBuiltinDenyRules(): PermissionRule[] {
  return [
    'Read(~/.lightclaw/**)',
    'Write(~/.lightclaw/**)',
    'Edit(~/.lightclaw/**)',
  ].map(text => ({
    source: 'builtin',
    behavior: 'deny',
    value: parseRule(text),
  }))
}
