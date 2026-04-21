import type { LoadedSkill } from '../types.js'
import { rememberSkill } from './remember.js'
import { verifySkill } from './verify.js'

export const bundledSkills: LoadedSkill[] = [verifySkill, rememberSkill]

export function getBundledSkillByName(name: string): LoadedSkill | null {
  return bundledSkills.find(skill => skill.name === name) ?? null
}