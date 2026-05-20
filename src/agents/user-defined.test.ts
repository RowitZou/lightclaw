import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'

import {
  getAgent,
  getAllAgents,
  initializeAgents,
  initializeUserDefinedAgents,
  reloadUserDefinedAgents,
  resetAgentRegistryForTest,
} from './registry.js'
import {
  loadUserDefinedRoles,
  parseUserDefinedRole,
  stopUserDefinedRoleWatchersForTest,
  UserDefinedRoleError,
} from './user-defined.js'

let tmpHome = ''

beforeEach(async () => {
  tmpHome = await mkdtemp(path.join(tmpdir(), 'lightclaw-user-roles-'))
  resetAgentRegistryForTest()
})

afterEach(async () => {
  stopUserDefinedRoleWatchersForTest(tmpHome)
  resetAgentRegistryForTest()
  await rm(tmpHome, { recursive: true, force: true })
})

test('loads a valid user-defined ROLE.md', async () => {
  const rolePath = await writeRole('paper-coordinator', validRole())
  const role = await parseUserDefinedRole(rolePath)

  assert.equal(role.agentType, 'paper-coordinator')
  assert.equal(role.kind, 'worker')
  assert.deepEqual(role.tools, ['Read', 'Grep', 'MemoryWrite'])
  assert.deepEqual(role.skills, ['remember'])
  assert.match(role.systemPrompt, /focused reader/)
})

test('rejects wildcard tools, Dispatch, unknown skills, and bundled name conflicts', async () => {
  await assertRoleError(validRole({ name: 'bad-wild', tools: ['*'] }), 'wildcard-tools-not-allowed')
  await assertRoleError(validRole({ name: 'bad-dispatch', tools: ['Read', 'Dispatch'] }), 'dispatch-not-allowed-for-user-defined')
  await assertRoleError(validRole({ name: 'bad-skill', skills: ['custom-skill'] }), 'user-defined-skill-not-allowed')
  await assertRoleError(validRole({ name: 'coder' }), 'role-name-collision-with-bundled')
})

test('reports duplicate user-defined role names', async () => {
  await writeRole('one', validRole({ name: 'dupe' }))
  await writeRole('two', validRole({ name: 'dupe' }))

  const loaded = await loadUserDefinedRoles(tmpHome)
  assert.equal(loaded.roles.length, 1)
  assert.equal(loaded.errors[0]?.reason, 'role-name-collision-with-user-defined')
})

test('initialization appends user-defined roles without replacing bundled roles', async () => {
  await writeRole('paper-coordinator', validRole())
  await initializeUserDefinedAgents({ home: tmpHome, failOnError: true, watch: false })

  assert.ok(getAgent('main'))
  assert.equal(getAgent('paper-coordinator')?.agentType, 'paper-coordinator')
  assert.ok(getAllAgents().some(role => role.agentType === 'paper-coordinator'))
})

test('cold start fails loudly on invalid role files', async () => {
  await writeRole('bad', validRole({ tools: ['*'] }))

  await assert.rejects(
    initializeUserDefinedAgents({ home: tmpHome, failOnError: true, watch: false }),
    /wildcard-tools-not-allowed/,
  )
})

test('hot reload keeps old role when new file is invalid', async () => {
  await writeRole('paper-coordinator', validRole({ description: 'old description' }))
  await initializeUserDefinedAgents({ home: tmpHome, failOnError: true, watch: false })
  assert.equal(getAgent('paper-coordinator')?.description, 'old description')

  await writeRole('paper-coordinator', validRole({ description: 'new description', tools: ['*'] }))
  const ok = await reloadUserDefinedAgents(tmpHome)

  assert.equal(ok, false)
  assert.equal(getAgent('paper-coordinator')?.description, 'old description')
})

test('hot reload replaces future roster after a valid change', async () => {
  await writeRole('paper-coordinator', validRole({ description: 'old description' }))
  initializeAgents()
  await reloadUserDefinedAgents(tmpHome)
  assert.equal(getAgent('paper-coordinator')?.description, 'old description')

  await writeRole('paper-coordinator', validRole({ description: 'new description' }))
  const ok = await reloadUserDefinedAgents(tmpHome)

  assert.equal(ok, true)
  assert.equal(getAgent('paper-coordinator')?.description, 'new description')
})

async function assertRoleError(markdown: string, reason: UserDefinedRoleError['reason']): Promise<void> {
  const rolePath = await writeRole(`case-${reason}`, markdown)
  await assert.rejects(
    parseUserDefinedRole(rolePath),
    (error: unknown) => error instanceof UserDefinedRoleError && error.reason === reason,
  )
}

async function writeRole(dirName: string, content: string): Promise<string> {
  const dir = path.join(tmpHome, 'roles', dirName)
  await mkdir(dir, { recursive: true })
  const rolePath = path.join(dir, 'ROLE.md')
  await writeFile(rolePath, content, 'utf8')
  return rolePath
}

function validRole(overrides: {
  name?: string
  description?: string
  tools?: string[]
  skills?: string[]
} = {}): string {
  const name = overrides.name ?? 'paper-coordinator'
  const description = overrides.description ?? 'Coordinates paper-reading tasks.'
  const tools = overrides.tools ?? ['Read', 'Grep', 'MemoryWrite']
  const skills = overrides.skills ?? ['remember']
  return [
    '---',
    `name: ${name}`,
    'whenToUse: User asks to coordinate paper-reading tasks.',
    `description: ${description}`,
    'tools:',
    ...tools.map(tool => `  - ${tool}`),
    'skills:',
    ...skills.map(skill => `  - ${skill}`),
    'kind: worker',
    'maxTurns: 20',
    '---',
    '',
    'You are a focused reader and organizer for academic papers.',
    '',
  ].join('\n')
}
