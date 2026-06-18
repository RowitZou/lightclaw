import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { memoryCuratorPrompt } from './memoryCurator.js'
import { skillConsolidatorPrompt } from './skillConsolidator.js'
import { skillCuratorPrompt } from './skillCurator.js'

/**
 * Lightweight semantic contracts for the two destructive-pair-emitting
 * dispatched curators. The full role-prompt snapshot test (see
 * `role-prompt.snapshot.test.ts`) pins byte-level identity; these
 * assertions guard the intent that landed in the 2026-05-26 dogfood
 * follow-up: if a future rewrite forgets to instruct the model to
 * sequence the destructive pair after a successful write, the silent
 * data loss surfaces again. Failing these tests is intentional only when
 * the prompt is being deliberately redesigned (and then the test should
 * be updated alongside the prompt in the same PR).
 *
 * Each phrase only needs to APPEAR somewhere in the prompt body — the
 * snapshot test handles full-text identity. Tests use `assert.match`
 * against literal substrings so unrelated rewording (e.g. "tool_result"
 * → "tool result envelope") can still pass as long as both anchor
 * phrases survive.
 */

describe('skillConsolidator prompt destructive-pair sequencing contract', () => {
  it('carries dispatch_brief through merged skills instead of silently dropping it', () => {
    assert.match(skillConsolidatorPrompt, /Carry\s+the\s+dispatch\s+brief\s+through\s+the\s+merge/i)
    assert.match(skillConsolidatorPrompt, /Never\s+silently\s+drop\s+a\s+brief\s+a\s+merged-from\s+skill\s+carried/i)
  })

  it('forbids treating a single skill as a merge candidate', () => {
    assert.match(
      skillConsolidatorPrompt,
      /single\s+skill\s+is\s+never\s+a\s+merge\s+candidate/i,
    )
  })

  it('requires SkillWrite to be a standalone tool_use that waits for its result', () => {
    assert.match(skillConsolidatorPrompt, /standalone\s+tool_use/i)
    assert.match(skillConsolidatorPrompt, /wait\s+for\s+its\s+`tool_result`/i)
  })

  it('allows compose-existing and extract-new but keeps rewrites one parent at a time', () => {
    assert.match(skillConsolidatorPrompt, /Rewrite one over-inlined parent to reuse an existing sibling/)
    assert.match(skillConsolidatorPrompt, /Extract a shared procedure two or more parents re-state/)
    assert.match(skillConsolidatorPrompt, /via `SkillEdit`/)
    assert.match(skillConsolidatorPrompt, /Never wire every parent in a single pass/)
    assert.match(skillConsolidatorPrompt, /Composition is only real `UseSkill` calls in skill bodies/)
    assert.match(skillConsolidatorPrompt, /What counts as over-inlined/)
    assert.match(skillConsolidatorPrompt, /What counts as a shared flow worth extracting/)
    assert.doesNotMatch(skillConsolidatorPrompt, /Factor shared steps out into a NEW sub-skill/)
  })

  it('gates SkillDelete on SkillWrite returning is_error:false', () => {
    assert.match(skillConsolidatorPrompt, /Only\s+if\s+3\.a\s+returned\s+`is_error:false`/i)
  })

  it('forbids SkillDelete on the surviving name', () => {
    assert.match(skillConsolidatorPrompt, /Never\s+`SkillDelete`\s+the\s+surviving\s+name/i)
  })

  it('aborts the group entirely when 3.a returns is_error:true', () => {
    assert.match(skillConsolidatorPrompt, /abort\s+this\s+group\s+entirely/i)
  })

  it('forbids bundling 3.a and 3.b in the same assistant turn', () => {
    assert.match(
      skillConsolidatorPrompt,
      /Do\s+not\s+bundle\s+3\.a\s+and\s+3\.b\s+in\s+the\s+same\s+assistant\s+turn/i,
    )
  })

  it('requires final assistant text to enumerate what changed', () => {
    assert.match(skillConsolidatorPrompt, /count\s+of\s+successful\s+SkillWrite/i)
    assert.match(skillConsolidatorPrompt, /count\s+of\s+successful\s+SkillDelete/i)
  })

  it('forbids the "nothing to merge" claim when destructive tools fired', () => {
    assert.match(
      skillConsolidatorPrompt,
      /Never\s+say\s+"nothing\s+to\s+merge"\s+if\s+you\s+called\s+any\s+SkillWrite\s+or\s+SkillDelete/i,
    )
  })
})

describe('skillCurator prompt dispatch brief contract', () => {
  it('tells curators when to draft dispatch_brief for a new skill', () => {
    assert.match(skillCuratorPrompt, /dispatch_brief\*\*: optional\. Add one if delegating this work would force the dispatcher to settle something a worker can't discover on its own/i)
    assert.match(skillCuratorPrompt, /what to settle,\s+not how it runs/i)
  })

  it('includes dispatch_brief in the draft frontmatter template', () => {
    assert.match(skillCuratorPrompt, /dispatch_brief:\s+\|/)
  })
})

describe('memoryCurator prompt destructive-pair sequencing contract', () => {
  it('requires MemoryWriteAt as a standalone tool_use that waits for is_error:false', () => {
    assert.match(memoryCuratorPrompt, /standalone\s+tool_use/i)
    assert.match(memoryCuratorPrompt, /wait\s+for\s+`is_error:false`/i)
  })

  it('aborts the promotion when MemoryWriteAt returns is_error:true', () => {
    assert.match(memoryCuratorPrompt, /abort\s+the\s+promotion/i)
  })

  it('within-directory cleanup also waits for is_error:false before deleting', () => {
    // The cleanup-section instruction must explicitly chain write-then-wait-then-delete.
    // We check the sequence as three independent anchors rather than one greedy
    // regex so backticks / wrapping don't make the test brittle.
    const cleanupLine =
      memoryCuratorPrompt
        .split('\n')
        .find(line => line.includes('Merge new signal into existing topic files')) ?? ''
    assert.ok(
      cleanupLine.length > 0,
      'expected a "Merge new signal" cleanup bullet in the memoryCurator prompt',
    )
    assert.match(cleanupLine, /MemoryWriteAt/i)
    assert.match(cleanupLine, /wait\s+for\s+[`'"]?is_error:false[`'"]?/i)
    assert.match(cleanupLine, /MemoryDelete[^.]*originals/i)
    assert.match(cleanupLine, /If\s+the\s+write\s+fails,\s+do\s+not\s+delete/i)
  })

  it('requires final assistant text to enumerate destructive op counts', () => {
    assert.match(
      memoryCuratorPrompt,
      /count\s+of\s+successful\s+`MemoryWriteAt`\s+\/\s+`MemoryMove`\s+\/\s+`MemoryDelete`/i,
    )
  })

  it('forbids "nothing changed" claim when destructive tools fired', () => {
    assert.match(
      memoryCuratorPrompt,
      /Never\s+report\s+"nothing\s+changed"\s+if\s+you\s+actually\s+called\s+destructive\s+tools/i,
    )
  })
})
