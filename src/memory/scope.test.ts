import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import type { Role } from '../agents/types.js'
import {
  resolveMemoryDirsForRole,
  resolveReadableMemoryDirsForRole,
  resolveSourceTier,
} from './scope.js'

let tmpRoot = ''
let memoryDir = ''

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), 'lightclaw-memory-scope-'))
  memoryDir = path.join(tmpRoot, 'memory', 'alice')
})

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true })
})

describe('resolveMemoryDirsForRole', () => {
  it('uses root self and shared visibility for orchestrator roles', () => {
    const resolved = resolveMemoryDirsForRole(role({ agentType: 'main', kind: 'orchestrator' }), memoryDir)

    assert.equal(resolved.selfWriteDir, memoryDir)
    assert.deepEqual(resolved.readableDirs, [
      memoryDir,
      path.join(memoryDir, '_shared'),
    ])
  })

  it('uses role-private self and three-layer readable dirs for worker defaults', () => {
    const resolved = resolveMemoryDirsForRole(role({ agentType: 'localExplorer', kind: 'worker' }), memoryDir)

    assert.equal(resolved.selfWriteDir, path.join(memoryDir, 'localExplorer'))
    assert.deepEqual(resolved.readableDirs, [
      memoryDir,
      path.join(memoryDir, '_shared'),
      path.join(memoryDir, 'localExplorer'),
    ])
  })

  it('keeps directory resolution lazy', async () => {
    const resolved = resolveMemoryDirsForRole(role({ agentType: 'webSearcher', kind: 'worker' }), memoryDir)

    assert.equal(resolved.selfWriteDir, path.join(memoryDir, 'webSearcher'))
    await assert.rejects(() => mkdir(path.join(memoryDir, 'webSearcher'), { recursive: false }), {
      code: 'ENOENT',
    })
  })

  it('adds top-level role directories for internal roles', async () => {
    await mkdir(path.join(memoryDir, 'webSearcher'), { recursive: true })
    await mkdir(path.join(memoryDir, 'localExplorer'), { recursive: true })
    await mkdir(path.join(memoryDir, '_shared'), { recursive: true })

    const resolved = await resolveReadableMemoryDirsForRole(role({
      agentType: 'memoryExtractor',
      kind: 'internal',
    }), memoryDir)

    assert.deepEqual(new Set(resolved.readableDirs), new Set([
      memoryDir,
      path.join(memoryDir, '_shared'),
      path.join(memoryDir, 'webSearcher'),
      path.join(memoryDir, 'localExplorer'),
    ]))
  })
})

describe('resolveSourceTier', () => {
  it('classifies L1 / L2 / L3 paths under memory root', () => {
    assert.equal(resolveSourceTier(path.join(memoryDir, 'note.md'), memoryDir), 'L1')
    assert.equal(resolveSourceTier(path.join(memoryDir, '_shared', 'shared-note.md'), memoryDir), 'L2')
    assert.equal(resolveSourceTier(path.join(memoryDir, '_shared', 'sub', 'deep.md'), memoryDir), 'L2')
    assert.equal(resolveSourceTier(path.join(memoryDir, 'webSearcher', 'note.md'), memoryDir), 'L3')
    assert.equal(resolveSourceTier(path.join(memoryDir, 'coder', 'sub', 'deep.md'), memoryDir), 'L3')
  })

  it('returns null for paths outside the memory root', () => {
    assert.equal(resolveSourceTier(path.join(tmpRoot, 'outside.md'), memoryDir), null)
    assert.equal(resolveSourceTier(path.join(memoryDir, '..', 'sibling.md'), memoryDir), null)
    assert.equal(resolveSourceTier(memoryDir, memoryDir), null)
  })
})

function role(overrides: Partial<Role>): Role {
  return {
    agentType: 'test-role',
    whenToUse: 'when useful',
    tools: ['Read'],
    systemPrompt: 'system',
    ...overrides,
  }
}
