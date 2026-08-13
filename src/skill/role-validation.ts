import type { Role } from '../agents/types.js'
import { isToolVisibleToRole } from '../agents/role-tool-gate.js'
import type { RuntimeDriver } from '../config.js'
import type { SkillMeta } from './types.js'

// PR19 retired the main<->generalist skill bridge: the two surfaces are
// orthogonal now (manager vs executor), so a user skill is visible exactly
// to the roles its frontmatter names.
//
// 2026-08-13 scoped that gate to DISCOVERY surfaces (prompt listing,
// ListRoleSkill, dream curation). A user skill's `roles` frontmatter is an
// OWNERSHIP list (who may revise it — see writeUserSkill's stampRoles), not a
// read fence: when a non-internal role loads a skill by exact name via
// UseSkill, the requester that named it in the dispatch brief already decided
// it applies, so ownership does not block the load. Tool compatibility
// (`missingSkillToolsForRole`) and the runtime-driver gate still do — a skill
// whose tools the role cannot see is unusable regardless of who asked.
// Bundled skills keep the role.skills allowlist on every path (that list is
// authored role policy, not an ownership stamp), and internal curation roles
// keep the full gate everywhere (they rewrite skills, they don't execute
// them).

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

/** Skill frontmatter declares tools in permission-rule pattern form as often
 *  as bare names — skillify's authoring guidance says "Use patterns
 *  (`Bash(gh:*)`, not bare `Bash`)". Role visibility is a per-tool gate, so
 *  compatibility is judged on the base tool name; the parenthesized scope is
 *  the permission layer's concern. Exact-matching the full pattern both
 *  silently killed every skill written per that guidance (2026-07-10 review
 *  §1.7) and let a pattern on a blocked tool slip past the worker block via
 *  the wildcard fallthrough. */
function baseToolName(declared: string): string {
  const parenIndex = declared.indexOf('(')
  return (parenIndex === -1 ? declared : declared.slice(0, parenIndex)).trim()
}

/** Declared tools the role cannot see. Explicit-load callers report these by
 *  name so the agent can tell its requester exactly why the skill does not
 *  apply here, instead of a blanket "unknown skill". */
export function missingSkillToolsForRole(skill: SkillMeta, role: Role): string[] {
  if (!skill.allowedTools || skill.allowedTools.length === 0) {
    return []
  }
  return skill.allowedTools.filter(
    declared => !isToolVisibleToRole(role, baseToolName(declared)),
  )
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
  return missingSkillToolsForRole(skill, role).length === 0
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

/** Auto-loaded workflow skills are omitted from ListRoleSkill, but their
 *  manager-facing dispatch briefs still help the dispatcher phrase work for
 *  the role. This helper intentionally exposes only metadata, never body. */
export function visibleAutoLoadDispatchBriefsForRole(
  skills: SkillMeta[],
  role: Role,
  gate: SkillRuntimeGate = {},
): SkillMeta[] {
  return filterSkillsForRole(skills, role, gate).filter(skill =>
    skill.autoLoad && (skill.dispatchBrief?.trim().length ?? 0) > 0,
  )
}
