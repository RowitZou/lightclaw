import { z } from 'zod'

import {
  buildLoadedSkillInvocation,
  loadRegisteredSkill,
  refreshSkillRegistry,
} from '../skill/registry.js'
import { hasSkillAssets, materializeSkillAssets } from '../skill/skill-assets.js'
import { recordSkillUsage } from '../skill/loader.js'
import { isSkillCompatibleWithRole } from '../skill/role-validation.js'
import { getCurrentSessionContext } from '../session-context.js'
import { getCurrentUserId } from '../state.js'
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
      await refreshSkillRegistry(context.cwd, getCurrentUserId())
      const role = getCurrentSessionContext()?.currentRole
      const skill = await loadRegisteredSkill(input.name)
      if (!skill) {
        return {
          output: `Unknown skill: ${input.name}`,
          isError: true,
        }
      }
      if (role && skill && !isSkillCompatibleWithRole(skill, role, {
        runtimeDriver: context.config?.runtime.driver ?? null,
      })) {
        return {
          output: `Unknown skill: ${input.name}`,
          isError: true,
        }
      }
      let skillDir: string | undefined
      if (skill.body.includes('${LIGHTCLAW_SKILL_DIR}') && await hasSkillAssets(skill)) {
        skillDir = await materializeSkillAssets(skill, context.runtime)
      }
      const content = await buildLoadedSkillInvocation(skill, input.args, skillDir)

      // Fire-and-forget per-user skill last-used update. V1 audit-only (no
      // framework code reads it yet); reserved for Phase 8+ aging / SkillSearch
      // recency heuristics. Bundled skills live in module strings, not disk —
      // skip them. Failures only stderr-log so a skill call is never blocked.
      if (skill && skill.source === 'user' && skill.filePath) {
        void recordSkillUsage(skill.filePath).catch(error => {
          const detail = error instanceof Error ? error.message : String(error)
          process.stderr.write(`[use-skill] last_used_at update failed for ${input.name}: ${detail}\n`)
        })
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
