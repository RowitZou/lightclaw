import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import type { Role } from '../agents/types.js'
import {
  resolveMemoryDirsForRole,
  resolveReadableMemoryDirsForRole,
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
    const resolved = resolveMemoryDirsForRole(role({ agentType: 'explore', kind: 'worker' }), memoryDir)

    assert.equal(resolved.selfWriteDir, path.join(memoryDir, 'explore'))
    assert.deepEqual(resolved.readableDirs, [
      memoryDir,
      path.join(memoryDir, '_shared'),
      path.join(memoryDir, 'explore'),
    ])
  })

  it('keeps directory resolution lazy', async () => {
    const resolved = resolveMemoryDirsForRole(role({ agentType: 'web', kind: 'worker' }), memoryDir)

    assert.equal(resolved.selfWriteDir, path.join(memoryDir, 'web'))
    await assert.rejects(() => mkdir(path.join(memoryDir, 'web'), { recursive: false }), {
      code: 'ENOENT',
    })
  })

  it('adds top-level role directories for internal roles', async () => {
    await mkdir(path.join(memoryDir, 'web'), { recursive: true })
    await mkdir(path.join(memoryDir, 'explore'), { recursive: true })
    await mkdir(path.join(memoryDir, '_shared'), { recursive: true })

    const resolved = await resolveReadableMemoryDirsForRole(role({
      agentType: 'extract_memories',
      kind: 'internal',
    }), memoryDir)

    assert.deepEqual(new Set(resolved.readableDirs), new Set([
      memoryDir,
      path.join(memoryDir, '_shared'),
      path.join(memoryDir, 'web'),
      path.join(memoryDir, 'explore'),
    ]))
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
