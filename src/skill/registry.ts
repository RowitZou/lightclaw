import { discoverSkills, loadSkillBody } from './loader.js'
import type { LoadedSkill, SkillMeta } from './types.js'

let skillRegistry = new Map<string, SkillMeta>()

export async function refreshSkillRegistry(cwd: string): Promise<SkillMeta[]> {
  const skills = await discoverSkills(cwd)
  skillRegistry = new Map(skills.map(skill => [skill.name, skill]))
  return listRegisteredSkills()
}

export function listRegisteredSkills(): SkillMeta[] {
  return [...skillRegistry.values()].sort((left, right) => left.name.localeCompare(right.name))
}

export function getRegisteredSkill(name: string): SkillMeta | null {
  return skillRegistry.get(name) ?? null
}

export async function loadRegisteredSkill(name: string): Promise<LoadedSkill | null> {
  const skill = getRegisteredSkill(name)
  if (!skill) {
    return null
  }

  return {
    ...skill,
    body: await loadSkillBody(skill),
  }
}

export async function buildRegisteredSkillInvocation(
  name: string,
  args?: string,
): Promise<string | null> {
  const loadedSkill = await loadRegisteredSkill(name)
  if (!loadedSkill) {
    return null
  }

  const sections = [
    `Use the skill \"${loadedSkill.name}\" and follow its instructions for this task.`,
  ]

  if (loadedSkill.whenToUse) {
    sections.push(`When to use: ${loadedSkill.whenToUse}`)
  }

  if (args?.trim()) {
    sections.push(`Skill arguments:\n${args.trim()}`)
  }

  sections.push(loadedSkill.body.trim())
  return sections.join('\n\n')
}