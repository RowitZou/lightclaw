import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'

import { recordSkillOpAudit } from '../audit/skill-ops.js'
import { userSkillsRoot } from '../identity/paths.js'
import { parseFrontmatter } from '../memory/auto-memory.js'
import { getCurrentSessionContext } from '../session-context.js'
import {
  appendCompositionJournalEntry,
  buildCompositionJournalEntry,
} from '../skill/composition-journal.js'
import { normalizeSkillName } from '../skill/loader.js'
import { refreshSkillRegistry } from '../skill/registry.js'
import { getCurrentRole } from '../state.js'
import { buildTool } from '../tool.js'

const SKILL_EDIT_DESCRIPTION = `Edit one existing per-user skill by replacing exactly one
occurrence of \`old_string\` in its SKILL.md with \`new_string\`. Use this for
small, surgical revisions where preserving every other byte matters.

The match must be unique. The tool refuses edits that would change the
frontmatter \`name:\` value.`

export const skillEditTool = buildTool({
  name: 'SkillEdit',
  whenToUse: 'Surgically edit one existing per-user skill by unique string replacement.',
  shouldDefer: true,
  description: SKILL_EDIT_DESCRIPTION,
  searchHint: 'skill edit surgical old_string new_string SKILL.md',
  domain: 'host',
  riskLevel: 'write',
  inputSchema: z.object({
    name: z.string().min(1).describe('Existing per-user skill name to edit.'),
    old_string: z.string().min(1).describe('Exact unique text to replace.'),
    new_string: z.string().describe('Replacement text.'),
  }),
  suggestPermissionRules(input) {
    return [{ toolName: 'SkillEdit', ruleContent: input.name }]
  },
  async call(input, context) {
    const session = getCurrentSessionContext()
    const userId = session?.currentUserId
    const now = new Date().toISOString()
    let name: string
    try {
      name = normalizeSkillName(input.name)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      await recordSkillOpAudit({
        at: now,
        userId,
        tool: 'SkillEdit',
        name: input.name,
        status: 'failed',
        reason,
      })
      return { output: reason, isError: true }
    }
    if (!userId) {
      await recordSkillOpAudit({
        at: now,
        userId: undefined,
        tool: 'SkillEdit',
        name,
        status: 'denied',
        reason: 'no active user identity',
      })
      return {
        output: 'SkillEdit requires an active LightClaw user identity.',
        isError: true,
      }
    }

    const filePath = path.join(userSkillsRoot(userId), name, 'SKILL.md')
    try {
      const raw = await readFile(filePath, 'utf8')
      const matches = countOccurrences(raw, input.old_string)
      if (matches !== 1) {
        throw new Error(
          matches === 0
            ? 'old_string was not found in the skill.'
            : 'old_string appears more than once in the skill; refine it to a unique span.',
        )
      }
      const next = raw.replace(input.old_string, input.new_string)
      assertFrontmatterNameUnchanged(raw, next)
      await writeFile(filePath, next, { encoding: 'utf8', mode: 0o600 })
      await refreshSkillRegistry(context.cwd, userId)

      const beforeBody = parseFrontmatter(raw).body.trim()
      const afterBody = parseFrontmatter(next).body.trim()
      const journal = buildCompositionJournalEntry({
        skill: name,
        preBody: beforeBody,
        postBody: afterBody,
        rewriteAt: now,
        currentPassCreatedSkills: session?.skillCompositionCreatedSkills,
      })
      if (getCurrentRole()?.agentType === 'skillConsolidator' && journal) {
        await appendCompositionJournalEntry(userId, journal).catch(error => {
          const detail = error instanceof Error ? error.message : String(error)
          process.stderr.write(`[skill-edit] composition journal write failed: ${detail}\n`)
        })
      }

      await recordSkillOpAudit({
        at: now,
        userId,
        tool: 'SkillEdit',
        name,
        filePath,
        status: 'edited',
      })
      return { output: `Edited skill "${name}" at ${filePath}.` }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      await recordSkillOpAudit({
        at: now,
        userId,
        tool: 'SkillEdit',
        name,
        filePath,
        status: 'failed',
        reason,
      })
      return { output: reason, isError: true }
    }
  },
})

function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let index = 0
  while (true) {
    const next = haystack.indexOf(needle, index)
    if (next === -1) return count
    count += 1
    index = next + needle.length
  }
}

function assertFrontmatterNameUnchanged(before: string, after: string): void {
  const beforeName = parseFrontmatter(before).frontmatter.name
  const afterName = parseFrontmatter(after).frontmatter.name
  if (beforeName !== afterName) {
    throw new Error('SkillEdit cannot change the frontmatter name field.')
  }
}

export const __skillEditDescriptionForSnapshot = SKILL_EDIT_DESCRIPTION
