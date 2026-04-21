export type SkillSource = 'builtin' | 'user' | 'project'

export type SkillMeta = {
  name: string
  description: string
  whenToUse?: string
  userInvocable: boolean
  allowedTools?: string[]
  source: SkillSource
  filePath: string
}

export type LoadedSkill = SkillMeta & {
  body: string
}