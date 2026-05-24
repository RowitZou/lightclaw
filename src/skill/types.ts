export type SkillSource = 'builtin' | 'user'

export type SkillMeta = {
  name: string
  description: string
  whenToUse?: string
  allowedTools?: string[]
  roles: string[]
  source: SkillSource
  filePath: string
  /**
   * ISO8601 timestamp of the most recent UseSkill hit on this skill.
   * V1 audit-only: written best-effort by `recordSkillUsage` and parsed
   * from frontmatter `last_used_at`; no framework code reads it yet.
   * Reserved for Phase 8+ aging / SkillSearch recency heuristics.
   */
  lastUsedAt?: string
}

export type LoadedSkill = SkillMeta & {
  body: string
}
