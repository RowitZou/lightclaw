export type SkillBodyForComposition = {
  name: string
  body: string
}

const USE_SKILL_CALL_RE = /\bUseSkill\(\s*(['"])([^'"]+)\1\s*\)/g

export function findUseSkillReferences(body: string): string[] {
  const refs: string[] = []
  for (const match of body.matchAll(USE_SKILL_CALL_RE)) {
    const name = match[2]?.trim()
    if (name) refs.push(name)
  }
  return refs
}

export function buildUseSkillReverseDeps(
  skills: SkillBodyForComposition[],
): Map<string, Set<string>> {
  const deps = new Map<string, Set<string>>()
  for (const skill of skills) {
    for (const child of findUseSkillReferences(skill.body)) {
      if (child === skill.name) continue
      const parents = deps.get(child) ?? new Set<string>()
      parents.add(skill.name)
      deps.set(child, parents)
    }
  }
  return deps
}
