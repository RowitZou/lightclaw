import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import { bundledSkillDir, skillDirFor, userSkillDir } from './skill-dir.js'
import type { SkillMeta } from './types.js'

describe('skill-dir helpers (Phase 16)', () => {
  it('bundledSkillDir resolves to src/skill/bundled/<name> in dev mode', () => {
    // Tests run via `tsx --test`, so import.meta.url inside skill-dir.ts
    // points at the src tree — IS_DIST is false.
    const dir = bundledSkillDir('remember')
    assert.match(dir, /[\\/]src[\\/]skill[\\/]bundled[\\/]remember$/)
    assert.ok(path.isAbsolute(dir), 'must return an absolute path')
  })

  it('userSkillDir returns the parent directory of a SKILL.md path', () => {
    const filePath = path.join('/foo', 'bar', 'my-skill', 'SKILL.md')
    assert.equal(userSkillDir(filePath), path.join('/foo', 'bar', 'my-skill'))
  })

  it('skillDirFor dispatches by source field', () => {
    const builtin: SkillMeta = {
      name: 'remember',
      description: 'd',
      roles: [],
      source: 'builtin',
      filePath: 'builtin:remember',
    }
    const user: SkillMeta = {
      name: 'my-skill',
      description: 'd',
      roles: ['main'],
      source: 'user',
      filePath: '/tmp/skills/my-skill/SKILL.md',
    }
    assert.equal(skillDirFor(builtin), bundledSkillDir('remember'))
    assert.equal(skillDirFor(user), userSkillDir('/tmp/skills/my-skill/SKILL.md'))
  })
})
