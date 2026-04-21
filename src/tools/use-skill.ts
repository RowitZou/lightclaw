import { z } from 'zod'

import {
  buildRegisteredSkillInvocation,
  refreshSkillRegistry,
} from '../skill/registry.js'
import { buildTool } from '../tool.js'

export const useSkillTool = buildTool({
  name: 'UseSkill',
  description:
    'Load a named skill and return its full instructions so the agent can apply it in the current turn.',
  inputSchema: z.object({
    name: z.string().min(1),
    args: z.string().optional(),
  }),
  async call(input, context) {
    try {
      await refreshSkillRegistry(context.cwd)
      const content = await buildRegisteredSkillInvocation(input.name, input.args)
      if (!content) {
        return {
          output: `Unknown skill: ${input.name}`,
          isError: true,
        }
      }

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