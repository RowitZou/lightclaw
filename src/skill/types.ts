export type SkillSource = 'builtin' | 'user'

export type SkillMeta = {
  name: string
  description: string
  whenToUse?: string
  allowedTools?: string[]
  source: SkillSource
  filePath: string
}

export type LoadedSkill = SkillMeta & {
  body: string
}
