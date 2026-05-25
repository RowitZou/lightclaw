import type { LoadedSkill } from '../types.js'
import { bundledSkills } from './index.generated.js'

export { bundledSkills }

export function getBundledSkillByName(name: string): LoadedSkill | null {
  return bundledSkills.find(skill => skill.name === name) ?? null
}
