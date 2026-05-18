import { z } from 'zod'

import {
  buildRegisteredSkillInvocation,
  getRegisteredSkill,
  refreshSkillRegistry,
} from '../skill/registry.js'
import { isSkillCompatibleWithRole } from '../skill/role-validation.js'
import { getCurrentSessionContext } from '../session-context.js'
import { setActiveSkillAllowedTools } from '../state.js'
import { buildTool } from '../tool.js'

export const useSkillTool = buildTool({
  name: 'UseSkill',
  whenToUse: `Load a named skill from the Available Skills list and apply its instructions inline.`,
  shouldDefer: true,
  description: `Load a named skill and apply its instructions in the current turn. Skills carry domain knowledge and specialized procedures.

BLOCKING REQUIREMENT: when a skill in the Available Skills list (in your system prompt) matches the user's request, call UseSkill BEFORE generating any other response about the task. Do not paraphrase the skill, do not describe what it would do — call UseSkill and follow the loaded instructions.

If a skill's instructions have already been loaded earlier in this turn (you'll see them in your recent tool_results), do NOT call UseSkill again — apply the instructions directly.

\`args\` is optional and passes free-form arguments through to the skill.`,
  domain: 'host',
  riskLevel: 'safe',
  inputSchema: z.object({
    name: z.string().min(1),
    args: z.string().optional(),
  }),
  async call(input, context) {
    try {
      await refreshSkillRegistry(context.cwd)
      const role = getCurrentSessionContext()?.currentRole
      const skill = getRegisteredSkill(input.name)
      if (role && skill && !isSkillCompatibleWithRole(skill, role)) {
        return {
          output: `Unknown skill: ${input.name}`,
          isError: true,
        }
      }
      const content = await buildRegisteredSkillInvocation(input.name, input.args)
      if (!content) {
        return {
          output: `Unknown skill: ${input.name}`,
          isError: true,
        }
      }
      setActiveSkillAllowedTools(skill?.allowedTools)

      return {
        output: content,
      }
    } catch (error) {
      return {
        output: error instanceof Error ? error.message : String(error),
        isError: true,
      }
    }
  },
})
