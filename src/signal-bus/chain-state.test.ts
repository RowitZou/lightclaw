import assert from 'node:assert/strict'
import test from 'node:test'

import type { Role } from '../agents/types.js'
import {
  createRootChainState,
  deriveChildChainState,
  intersectToolPatterns,
} from './chain-state.js'

const mainRole: Role = {
  agentType: 'main',
  kind: 'orchestrator',
  whenToUse: 'main',
  systemPrompt: '',
  tools: ['*'],
}

const reviewerRole: Role = {
  agentType: 'reviewer',
  kind: 'worker',
  whenToUse: 'reviewer',
  systemPrompt: '',
  tools: ['Read', 'Grep', 'Dispatch'],
}

const coderRole: Role = {
  agentType: 'coder',
  kind: 'worker',
  whenToUse: 'coder',
  systemPrompt: '',
  tools: ['Read', 'Write', 'Dispatch'],
}

test('createRootChainState initializes a root dispatch chain', () => {
  const root = createRootChainState('alice@example', mainRole, 'feishu:dm:1')

  assert.match(root.chainId, /^chain-alice_example-[a-f0-9-]{8}$/)
  assert.equal(root.depth, 0)
  assert.equal(root.path.length, 1)
  assert.equal(root.path[0]?.role, 'main')
  assert.equal(root.path[0]?.sessionId, 'feishu:dm:1')
  assert.deepEqual(root.inheritedAllowedTools, ['*'])
  assert.equal(root.chainStartedAt, root.path[0]?.at)
})

test('deriveChildChainState increments depth and inherits root timestamps', () => {
  const root = createRootChainState('alice', mainRole, 'root-session')
  const child = deriveChildChainState(root, reviewerRole, 'reviewer-session', 'd1')

  assert.equal(child.chainId, root.chainId)
  assert.equal(child.depth, 1)
  assert.equal(child.parentDispatchId, 'root')
  assert.equal(child.chainStartedAt, root.chainStartedAt)
  assert.deepEqual(child.path.map(node => node.role), ['main', 'reviewer'])
  assert.deepEqual(child.inheritedAllowedTools, ['Read', 'Grep', 'Dispatch'])
})

test('deriveChildChainState keeps allowed tools monotonic across multiple hops', () => {
  const root = createRootChainState('alice', mainRole, 'root-session')
  const reviewer = deriveChildChainState(root, reviewerRole, 'reviewer-session', 'd1')
  const coder = deriveChildChainState(reviewer, coderRole, 'coder-session', 'd2')

  assert.equal(coder.depth, 2)
  assert.equal(coder.parentDispatchId, 'd1')
  assert.deepEqual(coder.path.map(node => node.role), ['main', 'reviewer', 'coder'])
  assert.deepEqual(coder.inheritedAllowedTools, ['Read', 'Dispatch'])
})

test('intersectToolPatterns treats wildcard as inherited upper bound', () => {
  assert.deepEqual(intersectToolPatterns(['*'], ['Read', 'Write']), ['Read', 'Write'])
  assert.deepEqual(intersectToolPatterns(['Read', 'Write'], ['*']), ['Read', 'Write'])
  assert.deepEqual(intersectToolPatterns(['Read', 'Bash'], ['Read', 'Write']), ['Read'])
})
