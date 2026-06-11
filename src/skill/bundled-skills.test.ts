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
    assert.deepEqual(skillify!.allowedTools, [
      'SkillWrite',
      'AskUserQuestion',
      'Read',
      'Grep',
      'Glob',
    ])
    assert.deepEqual(skillify!.roles, [])
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
