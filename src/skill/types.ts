export type SkillSource = 'builtin' | 'user'
export type SkillRequiredDriver = 'brainpp'

export type SkillMeta = {
  name: string
  description: string
  whenToUse?: string
  /**
   * Manager-facing contract for delegation. This is parsed from frontmatter
   * `dispatch_brief`; prompt rendering intentionally happens elsewhere.
   */
  dispatchBrief?: string
  allowedTools?: string[]
  roles: string[]
  requiresDriver?: SkillRequiredDriver
  source: SkillSource
  filePath: string
  /**
   * ISO8601 timestamp of the most recent UseSkill hit on this skill.
   * Written best-effort by `recordSkillUsage` and parsed from frontmatter
   * `last_used_at`; prompt budget rendering uses it as the primary recency
   * signal for per-user skill LRU ordering.
   */
  lastUsedAt?: string
  /**
   * Cached prompt hot-path recency in epoch milliseconds. User skills use
   * max(parse(last_used_at), SKILL.md mtime); bundled skills may leave this
   * unset because they stay in the core full-render tier.
   */
  recencyMs?: number
  /**
   * When true, the framework injects this skill's body into the system prompt
   * of every role in `roles` on turn 1 — the agent does not call `UseSkill`.
   * Use for a role's primary always-on workflow (it would otherwise depend on
   * the model remembering to load it first). Auto-loaded skills are excluded
   * from the `## Available Skills` listing, so `when_to_use` is no longer a
   * trigger; keep `description` short purely for skill-system compatibility.
   */
  autoLoad?: boolean
}

export type LoadedSkill = SkillMeta & {
  body: string
}
