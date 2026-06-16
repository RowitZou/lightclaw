import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { bundledSkills, getBundledSkillByName } from './bundled/index.js'

describe('bundled skills (Phase 16 codegen output)', () => {
  it('contains exactly the expected bundled skill names', () => {
    const names = bundledSkills.map(s => s.name).sort()
    assert.deepEqual(names, ['archive-workflow', 'brainpp-batch-job', 'build-environment', 'coding-workflow', 'delivery-orchestration', 'feishu-doc-workflow', 'local-exploration-workflow', 'pre-delivery-review-workflow', 'remember', 'skillify', 'web-research-workflow'])
  })

  it('every skill is tagged source=builtin with the canonical filePath sentinel', () => {
    for (const skill of bundledSkills) {
      assert.equal(skill.source, 'builtin')
      assert.equal(skill.filePath, `builtin:${skill.name}`)
    }
  })

  it('remember frontmatter matches the pre-Phase-16 LoadedSkill shape', () => {
    const remember = getBundledSkillByName('remember')
    assert.ok(remember, 'remember skill must be present')
    assert.equal(
      remember!.description,
      'Persist or review durable facts worth keeping across sessions. For repeatable methods use `skillify` instead.',
    )
    assert.deepEqual(remember!.allowedTools, [
      'MemoryRead',
      'MemoryWrite',
      'Read',
      'Grep',
      'Glob',
    ])
    assert.deepEqual(remember!.roles, [])
  })

  it('skillify frontmatter matches the pre-Phase-16 LoadedSkill shape', () => {
    const skillify = getBundledSkillByName('skillify')
    assert.ok(skillify, 'skillify skill must be present')
    // AskUserQuestion left the list 2026-06-12: skillify ships to every
    // non-internal role, and workers ask upward instead of via the card.
    assert.deepEqual(skillify!.allowedTools, [
      'SkillWrite',
      'Read',
      'Grep',
      'Glob',
    ])
    assert.deepEqual(skillify!.roles, [])
  })

  it('brainpp-batch-job carries the reviewed dispatch brief and requester-first precedence', () => {
    const skill = getBundledSkillByName('brainpp-batch-job')
    assert.ok(skill, 'brainpp-batch-job skill must be present')
    assert.equal(
      skill!.dispatchBrief,
      [
        "Whoever asked you can't reach the worker — so the inputs only they can settle are yours to pin down before you dispatch, not the worker's to discover. Three recur:",
        '- the container image, and any ready-made environment it should carry or reuse;',
        '- where the weights, datasets, or checkpoints live — a mountable cluster path to point the worker at, not to fetch;',
        '- any GPU or resource figure that was fixed for you.',
        "Ask up for any you can't decide yourself, then hand the worker the settled values as a complete instruction — and record them so you don't have to re-ask next time. The worker knows the whole procedure: you put forward the goal, those inputs, and what a successful run looks like, and leave how the job runs to it — don't script its steps. If it still needs something only the person who asked you can answer, pass that up rather than guessing — and never have it invent, probe, or pull an image on its own.",
      ].join('\n'),
    )
    assert.match(
      skill!.body,
      /have the image\*\* \(a precondition — handed to you by your requester, from your library, or ask upward; never guess-and-pull one\)/,
    )
    assert.match(
      skill!.body,
      /Assemble the spec — take what your requester handed you first, then your library; default or ask only for what's still missing\./,
    )
    assert.match(
      skill!.body,
      /Image\*\* — use the one you were handed; else reuse from your library; nothing either way → \*\(blocker\)\*\./,
    )
  })

  it('build-environment carries the reviewed dispatch brief', () => {
    const skill = getBundledSkillByName('build-environment')
    assert.ok(skill, 'build-environment skill must be present')
    assert.equal(
      skill!.dispatchBrief,
      [
        "The worker reads the project and the machine and derives most of the plan itself — you don't pre-decide the package list. What's yours to settle before you dispatch: which project to build the environment for, the machine or compute target it must run on (CPU vs a specific accelerator — the wrong one wastes the whole install), and any version or base image the requester fixed. Ask up for any you can't decide, hand them over as a complete instruction, and record what ends up working so you don't re-derive it next time.",
        "Before the expensive install the worker confirms the whole plan once, with a recommended default, and that comes back up to you — answer it or relay it to whoever asked, then leave the install and validation to it. Don't script how it builds.",
      ].join('\n'),
    )
  })

  it('remember body byte-identical to the pre-Phase-16 join(\\n) form', () => {
    const expected = [
      '# Remember',
      '',
      'Review the current memory set and improve its signal-to-noise ratio.',
      '',
      '## Process',
      '1. Gather project memory and auto-memory entries.',
      '2. Classify each item as keep, revise, promote to LIGHTCLAW.md, or delete.',
      '3. Explain why each action is appropriate.',
      '4. Confirm with your requester before destructive cleanup that was not explicitly requested.',
      '',
      '## Guidance',
      '- Preserve stable conventions and durable preferences.',
      '- Remove stale, temporary, or redundant notes.',
      '- Prefer concise durable memory over long transcripts or task-specific noise.',
    ].join('\n')
    assert.equal(getBundledSkillByName('remember')!.body, expected)
  })

  it('skillify body retains framework template placeholders unsubstituted', () => {
    const skillify = getBundledSkillByName('skillify')
    assert.ok(skillify, 'skillify skill must be present')
    // These placeholders are resolved at UseSkill invocation time by
    // registry.ts; they must survive untouched in the bundled body.
    assert.ok(skillify!.body.includes('{{userDescriptionBlock}}'))
    assert.ok(skillify!.body.includes('{{sessionMemory}}'))
    assert.ok(skillify!.body.includes('{{userMessages}}'))
    // The skillify body opens with the title heading (sanity check on
    // codegen body.trim() not eating the leading bytes).
    assert.ok(skillify!.body.startsWith('# Skillify {{userDescriptionBlock}}'))
  })
})
