import assert from 'node:assert/strict'
import test from 'node:test'

import type { ResolvedRolePolicy } from '../agents/role-presets.js'
import type { Role } from '../agents/types.js'
import type { LightClawConfig } from '../config.js'
import {
  createRootChainState,
  deriveChildChainState,
} from './chain-state.js'
import {
  ChainGuardError,
  assertChainGuards,
  effectiveMaxChainDepth,
} from './chain-guard.js'

const mainRole = role('main', ['*'])
const reviewerRole = role('reviewer', ['Read', 'Dispatch'])
const coderRole = role('coder', ['Read', 'Write', 'Dispatch'])

test('assertChainGuards allows a reachable monotonic child below depth cap', () => {
  const root = createRootChainState('alice', mainRole, 'root-session')
  const child = deriveChildChainState(root, reviewerRole, 'reviewer-session', 'd1')

  assert.doesNotThrow(() => assertChainGuards({
    parent: root,
    child,
    callerPolicy: policy(['reviewer']),
    callee: reviewerRole,
    config: config(),
  }))
})

test('assertChainGuards rejects chain-too-deep', () => {
  const root = createRootChainState('alice', mainRole, 'root-session')
  const reviewer = deriveChildChainState(root, reviewerRole, 'reviewer-session', 'd1')
  const coder = deriveChildChainState(reviewer, coderRole, 'coder-session', 'd2')

  assertReason(() => assertChainGuards({
    parent: reviewer,
    child: coder,
    callerPolicy: policy(['coder']),
    callee: coderRole,
    config: config({ maxChainDepth: 1 }),
  }), 'chain-too-deep')
})

test('assertChainGuards rejects chain-cycle', () => {
  const root = createRootChainState('alice', mainRole, 'root-session')
  const reviewer = deriveChildChainState(root, reviewerRole, 'reviewer-session', 'd1')
  const cycle = deriveChildChainState(reviewer, reviewerRole, 'reviewer-again', 'd2')

  assertReason(() => assertChainGuards({
    parent: reviewer,
    child: cycle,
    callerPolicy: policy(['reviewer']),
    callee: reviewerRole,
    config: config(),
  }), 'chain-cycle')
})

test('assertChainGuards rejects role-not-reachable', () => {
  const root = createRootChainState('alice', mainRole, 'root-session')
  const child = deriveChildChainState(root, reviewerRole, 'reviewer-session', 'd1')

  assertReason(() => assertChainGuards({
    parent: root,
    child,
    callerPolicy: policy(['coder']),
    callee: reviewerRole,
    config: config(),
  }), 'role-not-reachable')
})

test('effectiveMaxChainDepth clamps declared depth to ceiling', () => {
  assert.equal(effectiveMaxChainDepth(config({ maxChainDepth: 9, maxChainDepthCeiling: 5 })), 5)
})

test('depth-4 chain (e.g. main → reviewer → coder → leaf) fits within default maxChainDepth', () => {
  // Phase 9 PR2: bundled dispatch matrix has paths of node-length 4 (depth 3).
  // Default maxChainDepth is 4 to leave one layer of headroom; the deepest
  // bundled chain (main → reviewer → coder → leaf-info-worker) must pass.
  const leafRole = role('localExplorer', ['Read'])
  const root = createRootChainState('alice', mainRole, 'root-session')
  const reviewer = deriveChildChainState(root, reviewerRole, 'reviewer-session', 'd1')
  const coder = deriveChildChainState(reviewer, coderRole, 'coder-session', 'd2')
  const leaf = deriveChildChainState(coder, leafRole, 'leaf-session', 'd3')

  assert.doesNotThrow(() => assertChainGuards({
    parent: coder,
    child: leaf,
    callerPolicy: policy(['localExplorer']),
    callee: leafRole,
    config: config({ maxChainDepth: 4 }),
  }))
})

function assertReason(fn: () => void, reason: ChainGuardError['reason']): void {
  assert.throws(fn, error => error instanceof ChainGuardError && error.reason === reason)
}

function role(agentType: string, tools: string[] | ['*']): Role {
  return {
    agentType,
    whenToUse: agentType,
    systemPrompt: '',
    tools,
    kind: agentType === 'main' ? 'orchestrator' : 'worker',
  }
}

function policy(reachableRoles: string[]): ResolvedRolePolicy {
  return {
    name: 'caller',
    kind: 'worker',
    tools: ['Dispatch'],
    skills: [],
    mcpServers: [],
    reachableRoles,
    hooks: ['*'],
    outputContract: 'report',
  }
}

function config(dispatch?: Partial<LightClawConfig['dispatch']>): LightClawConfig {
  return {
    dispatch: {
      maxChainDepth: dispatch?.maxChainDepth ?? 3,
      maxChainDepthCeiling: dispatch?.maxChainDepthCeiling ?? 5,
    },
  } as LightClawConfig
}
