import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

import { parseRule } from './rules.js'
import { getBuiltinDenyRules } from './builtin-rules.js'
import type { PermissionRule, PermissionRuleSource } from './types.js'

type PermissionFileShape = {
  allow?: string[]
  deny?: string[]
}

function expandHomePath(input: string): string {
  if (input === '~') {
    return homedir()
  }

  if (input.startsWith('~/')) {
    return path.join(homedir(), input.slice(2))
  }

  return input
}

function loadFile(pathname: string, source: PermissionRuleSource): PermissionRule[] {
  if (!existsSync(pathname)) {
    return []
  }

  let parsed: PermissionFileShape
  try {
    parsed = JSON.parse(readFileSync(pathname, 'utf8')) as PermissionFileShape
  } catch {
    return []
  }

  const rules: PermissionRule[] = []
  for (const text of parsed.allow ?? []) {
    try {
      rules.push({ source, behavior: 'allow', value: parseRule(text) })
    } catch {
      // Ignore invalid persisted rules so one typo does not break startup.
    }
  }

  for (const text of parsed.deny ?? []) {
    try {
      rules.push({ source, behavior: 'deny', value: parseRule(text) })
    } catch {
      // Ignore invalid persisted rules so one typo does not break startup.
    }
  }

  return rules
}

export function loadFileRules(input: {
  cwd: string
  userPath?: string
  projectPath?: string
  localPath?: string
}): PermissionRule[] {
  const userPath = path.resolve(
    expandHomePath(input.userPath ?? path.join(homedir(), '.lightclaw', 'permissions.json')),
  )
  const projectPath = path.resolve(
    input.cwd,
    expandHomePath(input.projectPath ?? path.join('.lightclaw', 'permissions.json')),
  )
  const localPath = path.resolve(
    input.cwd,
    expandHomePath(input.localPath ?? path.join('.lightclaw', 'permissions.local.json')),
  )

  return [
    ...loadFile(localPath, 'local'),
    ...loadFile(projectPath, 'project'),
    ...loadFile(userPath, 'user'),
    ...getBuiltinDenyRules(),
  ]
}
