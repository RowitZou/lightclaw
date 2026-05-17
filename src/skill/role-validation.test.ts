import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'

import type { Role } from '../agents/types.js'
import type { SkillMeta } from './types.js'
import {
  filterSkillsForRole,
  isSkillCompatibleWithRole,
  isSkillNameAllowedForRole,
} from './role-validation.js'

let restoreStderr: (() => void) | null = null

afterEach(() => {
  restoreStderr?.()
  restoreStderr = null
})

test('wildcard role skills allow compatible skills', () => {
  assert.equal(
    isSkillCompatibleWithRole(
      skill({ name: 'verify', allowedTools: ['Bash', 'Read'] }),
      role({ tools: ['*'], skills: ['*'] }),
    ),
    true,
  )
})

test('missing role.skills hides the skill even when tools are present', () => {
  const meta = skill({ name: 'remember', allowedTools: ['MemoryWrite'] })
  const worker = role({ tools: ['MemoryWrite'] })

  assert.equal(isSkillNameAllowedForRole(meta, worker), false)
  assert.equal(isSkillCompatibleWithRole(meta, worker), false)
})

test('named role skills allow only matching skill names', () => {
  const remember = skill({ name: 'remember' })
  const verify = skill({ name: 'verify' })
  const main = role({ tools: ['*'], skills: ['remember'] })

  assert.equal(isSkillNameAllowedForRole(remember, main), true)
  assert.equal(isSkillNameAllowedForRole(verify, main), false)
})

test('allowedTools must be visible to the role after worker blocks', () => {
  assert.equal(
    isSkillCompatibleWithRole(
      skill({ name: 'delegate', allowedTools: ['Dispatch'] }),
      role({ kind: 'worker', tools: ['*'], skills: ['delegate'] }),
    ),
    false,
  )
})

test('filterSkillsForRole drops incompatible skills and warns once per drop', () => {
  const writes: string[] = []
  const originalWrite = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string | Uint8Array) => {
    writes.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  restoreStderr = () => {
    process.stderr.write = originalWrite
  }

  const filtered = filterSkillsForRole(
    [
      skill({ name: 'verify', allowedTools: ['Read'] }),
      skill({ name: 'delegate', allowedTools: ['Dispatch'] }),
      skill({ name: 'hidden', allowedTools: ['Read'] }),
    ],
    role({ kind: 'worker', tools: ['Read', 'Dispatch'], skills: ['verify', 'delegate'] }),
  )

  assert.deepEqual(filtered.map(item => item.name), ['verify'])
  assert.equal(writes.length, 1)
  assert.match(writes[0] ?? '', /skipped "delegate" for role "test-role"/)
})

function role(overrides: Partial<Role>): Role {
  return {
    agentType: 'test-role',
    kind: 'worker',
    whenToUse: 'test',
    tools: ['Read'],
    systemPrompt: 'system',
    ...overrides,
  }
}

function skill(overrides: Partial<SkillMeta>): SkillMeta {
  return {
    name: 'skill',
    description: 'A skill',
    userInvocable: true,
    source: 'builtin',
    filePath: 'builtin:skill',
    ...overrides,
  }
}
