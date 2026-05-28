import { z } from 'zod'

import { recordSkillOpAudit } from '../audit/skill-ops.js'
import { getCurrentSessionContext } from '../session-context.js'
import { recordSkillWriteFailure } from '../skill/destructive-guard.js'
import { refreshSkillRegistry } from '../skill/registry.js'
import { writeUserSkill } from '../skill/loader.js'
import { buildTool } from '../tool.js'

const SKILL_WRITE_DESCRIPTION = `Save a skill to the current user's skill set. \`name\` is a short kebab-case
identifier; \`markdown\` is the full SKILL.md (YAML frontmatter — name,
description, when_to_use, optional allowed-tools — then the workflow body).

\`files\` (optional) ships supporting files alongside SKILL.md: each path must
sit under \`scripts/\` (deterministic helpers the body runs) or \`references/\`
(longer docs the body reads on demand). Reference them from the body as
\`\${LIGHTCLAW_SKILL_DIR}/scripts/<file>\`, which resolves at use time.

\`overwrite\` defaults to false; set it true only to revise an existing skill.
Overwrite replaces the entire skill — re-send every file you want to keep,
because any file you leave out is dropped. The skill becomes loadable with
UseSkill on the next turn.

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
    files: z
      .array(z.object({
        path: z
          .string()
          .min(1)
          .describe('Relative path under scripts/ or references/, e.g. "scripts/parse.py". No absolute paths or "..".'),
        content: z.string().describe('File contents (UTF-8 text).'),
      }))
      .optional(),
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
      await recordSkillOpAudit({
        at: new Date().toISOString(),
        userId: undefined,
        tool: 'SkillWrite',
        name: input.name,
        status: 'denied',
        reason: 'no active user identity',
      })
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
        files: input.files,
        overwrite: input.overwrite,
      })
      await refreshSkillRegistry(context.cwd, userId)
      await recordSkillOpAudit({
        at: new Date().toISOString(),
        userId,
        tool: 'SkillWrite',
        name: meta.name,
        filePath: meta.filePath,
        fileCount: input.files?.length ?? 0,
        files: input.files?.map(file => file.path),
        status: 'written',
      })
      return {
        output: [
          `Saved skill "${meta.name}" to ${meta.filePath}.`,
          'It can be loaded with UseSkill on the next turn.',
        ].join('\n'),
      }
    } catch (error) {
      // Record the failure so an immediately-following same-name SkillDelete
      // (typical of the dream-curator destructive pattern) refuses instead of
      // silently dropping the prior on-disk skill. See
      // `src/skill/destructive-guard.ts`.
      recordSkillWriteFailure(userId, input.name)
      const reason = error instanceof Error ? error.message : String(error)
      process.stderr.write(
        `[skill-write] validation failed user=${userId} name=${input.name} reason=${reason}\n`,
      )
      await recordSkillOpAudit({
        at: new Date().toISOString(),
        userId,
        tool: 'SkillWrite',
        name: input.name,
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

export const __skillWriteDescriptionForSnapshot = SKILL_WRITE_DESCRIPTION
