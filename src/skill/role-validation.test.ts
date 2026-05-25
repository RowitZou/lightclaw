import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'

import { BUNDLED_AGENTS } from '../agents/bundled/index.js'
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
      skill({ name: 'reader', allowedTools: ['Bash', 'Read'] }),
      role({ tools: ['*'], skills: ['*'] }),
    ),
    true,
  )
})

test('skills without allowedTools are compatible with any named role skill', () => {
  assert.equal(
    isSkillCompatibleWithRole(
      skill({ name: 'plain' }),
      role({ tools: ['Read'], skills: ['plain'] }),
    ),
    true,
  )
})

test('skills with an empty allowedTools list are compatible with any named role skill', () => {
  assert.equal(
    isSkillCompatibleWithRole(
      skill({ name: 'plain', allowedTools: [] }),
      role({ tools: ['Read'], skills: ['plain'] }),
    ),
    true,
  )
})

test('roles with wildcard tools can load all named skills', () => {
  const filtered = filterSkillsForRole(
    [
      skill({ name: 'read-skill', allowedTools: ['Read'] }),
      skill({ name: 'write-skill', allowedTools: ['Write'] }),
      skill({ name: 'bash-skill', allowedTools: ['Bash'] }),
    ],
    role({ tools: ['*'], skills: ['read-skill', 'write-skill', 'bash-skill'] }),
  )

  assert.deepEqual(filtered.map(item => item.name), ['read-skill', 'write-skill', 'bash-skill'])
})

test('skills requiring tools outside the role allowlist are filtered with a warning', () => {
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
    [skill({ name: 'bash-flow', allowedTools: ['Bash'] })],
    role({ tools: ['Read'], skills: ['bash-flow'] }),
  )

  assert.deepEqual(filtered, [])
  assert.equal(writes.length, 1)
  assert.match(writes[0] ?? '', /requires tools \[Bash\] outside role tools/)
})

test('skills requiring a visible tool are loaded', () => {
  const filtered = filterSkillsForRole(
    [skill({ name: 'reader', allowedTools: ['Read'] })],
    role({ tools: ['Read', 'Grep'], skills: ['reader'] }),
  )

  assert.deepEqual(filtered.map(item => item.name), ['reader'])
})

test('missing role.skills hides the skill even when tools are present', () => {
  const meta = skill({ name: 'remember', allowedTools: ['MemoryWrite'] })
  const worker = role({ tools: ['MemoryWrite'] })

  assert.equal(isSkillNameAllowedForRole(meta, worker), false)
  assert.equal(isSkillCompatibleWithRole(meta, worker), false)
})

test('named role skills allow only matching skill names', () => {
  const remember = skill({ name: 'remember' })
  const skillify = skill({ name: 'skillify' })
  const main = role({ tools: ['*'], skills: ['remember'] })

  assert.equal(isSkillNameAllowedForRole(remember, main), true)
  assert.equal(isSkillNameAllowedForRole(skillify, main), false)
})

test('per-user skill roles control name visibility', () => {
  const coderSkill = skill({
    name: 'review-fix-loop',
    source: 'user',
    roles: ['coder'],
    allowedTools: ['Read'],
  })

  assert.equal(
    isSkillNameAllowedForRole(coderSkill, role({ agentType: 'coder', tools: ['Read'] })),
    true,
  )
  assert.equal(
    isSkillNameAllowedForRole(coderSkill, role({ agentType: 'reviewer', tools: ['Read'] })),
    false,
  )
})

test('main and generalist bridge per-user skill names but still respect tool compatibility', () => {
  const mainSkill = skill({
    name: 'main-flow',
    source: 'user',
    roles: ['main'],
    allowedTools: ['Read'],
  })
  const mainNotifySkill = skill({
    name: 'notify-flow',
    source: 'user',
    roles: ['main'],
    allowedTools: ['Notify'],
  })
  const generalistSkill = skill({
    name: 'generalist-flow',
    source: 'user',
    roles: ['generalist'],
    allowedTools: ['Read'],
  })
  const main = role({ agentType: 'main', kind: 'orchestrator', tools: ['*'] })
  const generalist = role({ agentType: 'generalist', kind: 'worker', tools: ['*'] })

  assert.equal(isSkillNameAllowedForRole(mainSkill, generalist), true)
  assert.equal(isSkillCompatibleWithRole(mainSkill, generalist), true)
  assert.equal(isSkillNameAllowedForRole(mainNotifySkill, generalist), true)
  assert.equal(isSkillCompatibleWithRole(mainNotifySkill, generalist), false)
  assert.equal(isSkillNameAllowedForRole(generalistSkill, main), true)
  assert.equal(isSkillCompatibleWithRole(generalistSkill, main), true)
})

test('bundled skills keep literal role allowlist semantics', () => {
  const skillify = skill({ name: 'skillify', source: 'builtin', roles: ['generalist'] })
  const main = role({ agentType: 'main', kind: 'orchestrator', tools: ['*'], skills: ['skillify'] })
  const generalist = role({ agentType: 'generalist', tools: ['*'], skills: ['remember'] })

  assert.equal(isSkillNameAllowedForRole(skillify, main), true)
  assert.equal(isSkillNameAllowedForRole(skillify, generalist), false)
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
      skill({ name: 'reader', allowedTools: ['Read'] }),
      skill({ name: 'delegate', allowedTools: ['Dispatch'] }),
      skill({ name: 'hidden', allowedTools: ['Read'] }),
    ],
    role({ kind: 'worker', tools: ['Read', 'Dispatch'], skills: ['reader', 'delegate'] }),
  )

  assert.deepEqual(filtered.map(item => item.name), ['reader'])
  assert.equal(writes.length, 1)
  assert.match(writes[0] ?? '', /skipped "delegate" for role "test-role"/)
})

test('coder and reviewer no longer expose scaffold verification skills', () => {
  const coder = BUNDLED_AGENTS.find(agent => agent.agentType === 'coder')
  const reviewer = BUNDLED_AGENTS.find(agent => agent.agentType === 'reviewer')

  assert.ok(coder)
  assert.ok(reviewer)
  assert.deepEqual(coder.skills, ['remember', 'coding-workflow'])
  assert.deepEqual(reviewer.skills, ['remember', 'pre-delivery-review-workflow'])
})

test('main role exposes remember and skillify', () => {
  const remember = skill({ name: 'remember', allowedTools: ['MemoryWrite'] })
  const skillify = skill({ name: 'skillify', allowedTools: ['SkillWrite'] })
  const main = BUNDLED_AGENTS.find(agent => agent.agentType === 'main')

  assert.ok(main)
  assert.deepEqual(filterSkillsForRole([remember, skillify], main).map(item => item.name), [
    'remember',
    'skillify',
  ])
})

test('Phase 7.5 workers expose remember where requested', () => {
  const remember = skill({ name: 'remember', allowedTools: ['MemoryWrite'] })
  const roleNames = ['generalist', 'coder', 'reviewer', 'archivist']
  for (const roleName of roleNames) {
    const agent = BUNDLED_AGENTS.find(candidate => candidate.agentType === roleName)
    assert.ok(agent, `missing role ${roleName}`)
    assert.deepEqual(filterSkillsForRole([remember], agent).map(item => item.name), ['remember'])
  }
})

test('archivist only keeps remember from the bundled meta-skill set', () => {
  const archivist = BUNDLED_AGENTS.find(agent => agent.agentType === 'archivist')

  assert.ok(archivist)
  assert.deepEqual(archivist.skills, ['remember'])
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
    roles: [],
    source: 'builtin',
    filePath: 'builtin:skill',
    ...overrides,
  }
}
