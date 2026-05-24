import { z } from 'zod'

import { getCurrentSessionContext } from '../session-context.js'
import { deleteUserSkill } from '../skill/loader.js'
import { refreshSkillRegistry } from '../skill/registry.js'
import { buildTool } from '../tool.js'

const SKILL_DELETE_DESCRIPTION = `Delete one per-user skill from the current user's skill set.
\`name\` is the skill's kebab-case identifier. Bundled skills cannot be deleted.
Use this only as part of an intentional skill consolidation or replacement workflow.`

export const skillDeleteTool = buildTool({
  name: 'SkillDelete',
  whenToUse: 'Delete a per-user skill after consolidating it into another saved skill.',
  shouldDefer: true,
  description: SKILL_DELETE_DESCRIPTION,
  searchHint: 'delete remove skill SKILL.md consolidate merge per-user',
  domain: 'host',
  riskLevel: 'write',
  inputSchema: z.object({
    name: z
      .string()
      .min(1)
      .describe('Short kebab-case skill identifier to delete from the current user skill set.'),
  }),
  suggestPermissionRules(input) {
    return [{ toolName: 'SkillDelete', ruleContent: input.name }]
  },
  async call(input, context) {
    const session = getCurrentSessionContext()
    const userId = session?.currentUserId
    if (!userId) {
      return {
        output: 'SkillDelete requires an active LightClaw user identity.',
        isError: true,
      }
    }

    try {
      const deleted = await deleteUserSkill({ userId, name: input.name })
      await refreshSkillRegistry(context.cwd, userId)
      return {
        output: `Deleted skill "${deleted.name}" from ${deleted.filePath}.`,
      }
    } catch (error) {
      return {
        output: error instanceof Error ? error.message : String(error),
        isError: true,
      }
    }
  },
})

export const __skillDeleteDescriptionForSnapshot = SKILL_DELETE_DESCRIPTION
