import { z } from 'zod'

import {
  buildLoadedSkillInvocation,
  loadRegisteredSkill,
  refreshSkillRegistry,
} from '../skill/registry.js'
import { hasSkillAssets, materializeSkillAssets } from '../skill/skill-assets.js'
import { recordSkillUsage } from '../skill/loader.js'
import {
  isSkillCompatibleWithRole,
  isSkillCompatibleWithRuntime,
  isSkillNameAllowedForRole,
  missingSkillToolsForRole,
} from '../skill/role-validation.js'
import { getCurrentSessionContext } from '../session-context.js'
import { getCurrentUserId } from '../state.js'
import { buildTool } from '../tool.js'

const INLINE_COMPOSE_CAP_MESSAGE =
  'composition breadth cap reached this turn; the loaded skills are enough — proceed'

function wrapSkillContent(name: string, content: string): string {
  const sanitizedContent = content.replaceAll('</skill-content>', '<\\/skill-content>')
  return `<skill-content name="${name}">\n${sanitizedContent}\n</skill-content>`
}

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
      if (role) {
        const gate = { runtimeDriver: context.config?.runtime.driver ?? null }
        if (role.kind === 'internal') {
          // Curation roles rewrite skills across the roster; they never
          // execute one, so they keep the full visibility gate.
          if (!isSkillCompatibleWithRole(skill, role, gate)) {
            return {
              output: `Unknown skill: ${input.name}`,
              isError: true,
            }
          }
        } else {
          // Explicit load by name: a user skill's `roles` frontmatter is an
          // ownership list, not a read fence — see role-validation.ts. What
          // still blocks the load is genuine inapplicability: a runtime-driver
          // mismatch, a bundled skill outside the role's authored allowlist,
          // or declared tools this role cannot see.
          if (!isSkillCompatibleWithRuntime(skill, gate)) {
            return {
              output:
                `Skill "${skill.name}" requires the "${skill.requiresDriver}" runtime driver, ` +
                'which is not active in this session.',
              isError: true,
            }
          }
          if (skill.source !== 'user' && !isSkillNameAllowedForRole(skill, role)) {
            return {
              output: `Unknown skill: ${input.name}`,
              isError: true,
            }
          }
          const missingTools = missingSkillToolsForRole(skill, role)
          if (missingTools.length > 0) {
            return {
              output:
                `Skill "${skill.name}" requires tools that are not available in this session: ` +
                `${missingTools.join(', ')}. It cannot be applied here.`,
              isError: true,
            }
          }
        }
      }
      const session = getCurrentSessionContext()
      const cap = Math.max(1, Math.floor(context.config?.skills.maxInlineComposePerTurn ?? 6))
      const count = (session?.inlineComposeThisTurn ?? 0) + 1
      if (session) session.inlineComposeThisTurn = count
      if (count > cap) {
        return {
          output: INLINE_COMPOSE_CAP_MESSAGE,
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
        output: wrapSkillContent(skill.name, content),
      }
    } catch (error) {
      return {
        output: error instanceof Error ? error.message : String(error),
        isError: true,
      }
    }
  },
})

export const __inlineComposeCapMessageForTest = INLINE_COMPOSE_CAP_MESSAGE
