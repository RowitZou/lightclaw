import { homedir } from 'node:os'
import path from 'node:path'

import { parseRule } from './rules.js'
import type { PermissionRule } from './types.js'

export function getBuiltinDenyRules(): PermissionRule[] {
  const homeLightclaw = path.join(homedir(), '.lightclaw')
  return [
    'Read(~/.lightclaw/**)',
    'Write(~/.lightclaw/**)',
    'Edit(~/.lightclaw/**)',
    `Read(${homeLightclaw}/**)`,
    `Write(${homeLightclaw}/**)`,
    `Edit(${homeLightclaw}/**)`,
  ].map(text => ({
    source: 'builtin',
    behavior: 'deny',
    value: parseRule(text),
  }))
}

