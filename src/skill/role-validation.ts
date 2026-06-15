import type { Role } from '../agents/types.js'
import { isToolVisibleToRole } from '../agents/role-tool-gate.js'
import type { RuntimeDriver } from '../config.js'
import type { SkillMeta } from './types.js'

// PR19 retired the main<->generalist skill bridge: the two surfaces are
// orthogonal now (manager vs executor), so a user skill is visible exactly
// to the roles its frontmatter names.

export type SkillRuntimeGate = {
  runtimeDriver?: RuntimeDriver
}

export function isSkillNameAllowedForRole(skill: SkillMeta, role: Role): boolean {
  if (skill.source === 'user') {
    return skill.roles.includes(String(role.agentType))
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

// A mis-fitting skill is a config fact, not a per-turn event: log each
// skill+role miss once per process, not on every prompt build.
const loggedSkips = new Set<string>()

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
    const skipKey = `${skill.name}\u0000${role.agentType}`
    if (!loggedSkips.has(skipKey)) {
      loggedSkips.add(skipKey)
      const requiredTools = skill.allowedTools?.join(', ') ?? ''
      process.stderr.write(
        `[skill] skipped "${skill.name}" for role "${role.agentType}": ` +
        `requires tools [${requiredTools}] outside role tools\n`,
      )
    }
    return false
  })
}

/** The skills a role invokes on demand via `UseSkill` — the load-on-demand
 *  set a dispatcher reasons about when routing work. Excludes `autoLoad`
 *  workflow skills (the framework injects those as the role's always-on
 *  procedure; they are identity, not a capability to delegate toward). This
 *  is the single source for both the `## Reachable Workers` skill-name line
 *  and the `ListRoleSkill` tool, so the two never drift. */
export function visibleOnDemandSkillsForRole(
  skills: SkillMeta[],
  role: Role,
  gate: SkillRuntimeGate = {},
): SkillMeta[] {
  return filterSkillsForRole(skills, role, gate).filter(skill => !skill.autoLoad)
}
