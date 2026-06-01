import type { Role } from '../agents/types.js'
import { isToolVisibleToRole } from '../agents/role-tool-gate.js'
import type { RuntimeDriver } from '../config.js'
import type { SkillMeta } from './types.js'

const MAIN_GENERALIST_PAIR = new Set(['main', 'generalist'])

export type SkillRuntimeGate = {
  runtimeDriver?: RuntimeDriver
}

export function isSkillNameAllowedForRole(skill: SkillMeta, role: Role): boolean {
  if (skill.source === 'user') {
    const roleName = String(role.agentType)
    if (skill.roles.includes(roleName)) {
      return true
    }
    return MAIN_GENERALIST_PAIR.has(roleName) &&
      skill.roles.some(skillRole => MAIN_GENERALIST_PAIR.has(skillRole))
  }

  const skills = (role.skills ?? []) as readonly string[]
  return skills.includes('*') || skills.includes(skill.name)
}

export function isSkillCompatibleWithRuntime(
  skill: SkillMeta,
  gate: SkillRuntimeGate = {},
): boolean {
  return !skill.requiresDriver || skill.requiresDriver === (gate.runtimeDriver ?? null)
}

export function isSkillCompatibleWithRole(
  skill: SkillMeta,
  role: Role,
  gate: SkillRuntimeGate = {},
): boolean {
  if (!isSkillCompatibleWithRuntime(skill, gate)) {
    return false
  }
  if (!isSkillNameAllowedForRole(skill, role)) {
    return false
  }
  if (!skill.allowedTools || skill.allowedTools.length === 0) {
    return true
  }
  return skill.allowedTools.every(toolName => isToolVisibleToRole(role, toolName))
}

export function filterSkillsForRole(
  skills: SkillMeta[],
  role: Role,
  gate: SkillRuntimeGate = {},
): SkillMeta[] {
  return skills.filter(skill => {
    if (!isSkillCompatibleWithRuntime(skill, gate)) {
      return false
    }
    if (!isSkillNameAllowedForRole(skill, role)) {
      return false
    }
    if (isSkillCompatibleWithRole(skill, role, gate)) {
      return true
    }
    const requiredTools = skill.allowedTools?.join(', ') ?? ''
    process.stderr.write(
      `[skill] skipped "${skill.name}" for role "${role.agentType}": ` +
      `requires tools [${requiredTools}] outside role tools\n`,
    )
    return false
  })
}
