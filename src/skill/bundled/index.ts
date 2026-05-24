import type { LoadedSkill } from '../types.js'
import { rememberSkill } from './remember.js'
import { skillifySkill } from './skillify.js'

export const bundledSkills: LoadedSkill[] = [rememberSkill, skillifySkill]

export function getBundledSkillByName(name: string): LoadedSkill | null {
  return bundledSkills.find(skill => skill.name === name) ?? null
}
