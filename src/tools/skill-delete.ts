import { z } from 'zod'

import { recordSkillOpAudit } from '../audit/skill-ops.js'
import { getCurrentSessionContext } from '../session-context.js'
import { getCurrentRole } from '../state.js'
import {
  hasSurvivorWriteOtherThan,
  shouldBlockSkillDelete,
} from '../skill/destructive-guard.js'
import { deleteUserSkill, normalizeSkillName } from '../skill/loader.js'
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
      await recordSkillOpAudit({
        at: new Date().toISOString(),
        userId: undefined,
        tool: 'SkillDelete',
        name: input.name,
        status: 'denied',
        reason: 'no active user identity',
      })
      return {
        output: 'SkillDelete requires an active LightClaw user identity.',
        isError: true,
      }
    }

    // Same-name destructive guard: if a SkillWrite for this name failed
    // recently, refuse the delete. Without this, a dispatched curator that
    // emits `SkillWrite(name:X) + SkillDelete(name:X)` in one batch silently
    // loses the prior on-disk skill when the write fails validation. See
    // `src/skill/destructive-guard.ts` and 2026-05-26 dogfood.
    let normalizedName: string
    try {
      normalizedName = normalizeSkillName(input.name)
    } catch (error) {
      // Defer to deleteUserSkill so invalid names produce the same error
      // shape downstream tests already assert on.
      normalizedName = input.name
    }
    // Consolidation survivor guard: skillConsolidator (the only role with
    // SkillDelete) must write a surviving skill BEFORE deleting the merged-from
    // names. A run that deletes without first writing any different survivor is
    // the 2026-05-29 data-loss class — the weak sub-LLM deleted two
    // user-requested skills and hallucinated a merge into an unrelated skill it
    // never wrote. The consolidator prompt already mandates write-then-delete;
    // this enforces it at the tool boundary. Scoped to the consolidator role so
    // other (test / future) SkillDelete callers are unaffected. See
    // `src/skill/destructive-guard.ts`.
    if (getCurrentRole()?.agentType === 'skillConsolidator') {
      const sessionId = session?.sessionId ?? ''
      if (!hasSurvivorWriteOtherThan(sessionId, normalizedName)) {
        process.stderr.write(
          `[skill-delete] refused user=${userId} name=${normalizedName} reason=consolidator delete without a survivor SkillWrite this run\n`,
        )
        await recordSkillOpAudit({
          at: new Date().toISOString(),
          userId,
          tool: 'SkillDelete',
          name: normalizedName,
          status: 'denied',
          reason: 'consolidation delete without a survivor SkillWrite this run',
        })
        return {
          output:
            `Refusing to delete skill "${normalizedName}": consolidation must first ` +
            `SkillWrite a surviving merged skill (a different name) in this run, then ` +
            `delete the merged-from names. No such survivor write happened, so deleting ` +
            `now would drop the skill with nothing replacing it. Write the merged ` +
            `survivor first (per the consolidation workflow), or leave this skill alone.`,
          isError: true,
        }
      }
    }

    const block = shouldBlockSkillDelete(userId, normalizedName)
    if (block.blocked) {
      const ageSec = Math.max(1, Math.round((block.ageMs ?? 0) / 1000))
      process.stderr.write(
        `[skill-delete] refused user=${userId} name=${normalizedName} reason=same-name SkillWrite failed ${ageSec}s ago\n`,
      )
      await recordSkillOpAudit({
        at: new Date().toISOString(),
        userId,
        tool: 'SkillDelete',
        name: normalizedName,
        status: 'denied',
        reason: `same-name SkillWrite failed ${ageSec}s ago`,
      })
      return {
        output:
          `Refusing to delete skill "${normalizedName}": a SkillWrite for the same name failed ` +
          `${ageSec}s ago. Deleting now would drop the still-present prior version. Retry the ` +
          `SkillWrite (fix the validation error first); once it returns is_error:false, the ` +
          `delete becomes safe.`,
        isError: true,
      }
    }

    try {
      const deleted = await deleteUserSkill({ userId, name: input.name })
      await refreshSkillRegistry(context.cwd, userId)
      process.stderr.write(
        `[skill-delete] deleted user=${userId} name=${deleted.name}\n`,
      )
      await recordSkillOpAudit({
        at: new Date().toISOString(),
        userId,
        tool: 'SkillDelete',
        name: deleted.name,
        filePath: deleted.filePath,
        status: 'deleted',
      })
      return {
        output: `Deleted skill "${deleted.name}" from ${deleted.filePath}.`,
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      await recordSkillOpAudit({
        at: new Date().toISOString(),
        userId,
        tool: 'SkillDelete',
        name: normalizedName,
        status: 'failed',
        reason,
      })
      return {
        output: reason,
        isError: true,
      }
    }
  },
})

export const __skillDeleteDescriptionForSnapshot = SKILL_DELETE_DESCRIPTION
