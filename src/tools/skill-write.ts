import { z } from 'zod'

import { getCurrentSessionContext } from '../session-context.js'
import { refreshSkillRegistry } from '../skill/registry.js'
import { writeUserSkill } from '../skill/loader.js'
import { buildTool } from '../tool.js'

const SKILL_WRITE_DESCRIPTION = `Save a SKILL.md to the current user's skill set. \`name\` is a short kebab-case
identifier; \`markdown\` is the full SKILL.md (YAML frontmatter — name,
description, when_to_use, optional allowed-tools — then the workflow body).
\`overwrite\` defaults to false; set it true only to revise an existing skill.
The skill becomes loadable with UseSkill on the next turn.

Follow the \`skillify\` skill for how and when to author a good skill.`

export const skillWriteTool = buildTool({
  name: 'SkillWrite',
  whenToUse: 'Save or revise a reusable per-user skill after following the skillify workflow.',
  shouldDefer: true,
  description: SKILL_WRITE_DESCRIPTION,
  searchHint: 'save skill write SKILL.md skillify reusable workflow per-user',
  domain: 'host',
  riskLevel: 'write',
  inputSchema: z.object({
    name: z
      .string()
      .min(1)
      .describe('Short kebab-case skill identifier. This must match the SKILL.md frontmatter name.'),
    markdown: z
      .string()
      .min(1)
      .describe('Complete SKILL.md content, including YAML frontmatter and markdown body.'),
    overwrite: z
      .boolean()
      .optional()
      .describe('Set true only when intentionally replacing an existing skill. Defaults to false.'),
  }),
  suggestPermissionRules(input) {
    return [{ toolName: 'SkillWrite', ruleContent: input.name }]
  },
  async call(input, context) {
    const session = getCurrentSessionContext()
    const userId = session?.currentUserId
    if (!userId) {
      return {
        output: 'SkillWrite requires an active LightClaw user identity.',
        isError: true,
      }
    }

    try {
      const meta = await writeUserSkill({
        userId,
        name: input.name,
        markdown: input.markdown,
        overwrite: input.overwrite,
      })
      await refreshSkillRegistry(context.cwd, userId)
      return {
        output: [
          `Saved skill "${meta.name}" to ${meta.filePath}.`,
          'It can be loaded with UseSkill on the next turn.',
        ].join('\n'),
      }
    } catch (error) {
      return {
        output: error instanceof Error ? error.message : String(error),
        isError: true,
      }
    }
  },
})

export const __skillWriteDescriptionForSnapshot = SKILL_WRITE_DESCRIPTION
