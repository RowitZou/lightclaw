import type { LoadedSkill } from '../types.js'
import { rememberSkill } from './remember.js'
import { skillifySkill } from './skillify.js'
import { verifyEnvSkill } from './verify-env.js'
import { verifySkill } from './verify.js'

export const bundledSkills: LoadedSkill[] = [verifySkill, verifyEnvSkill, rememberSkill, skillifySkill]

export function getBundledSkillByName(name: string): LoadedSkill | null {
  return bundledSkills.find(skill => skill.name === name) ?? null
}
