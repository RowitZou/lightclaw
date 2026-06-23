import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import type { Role } from '../agents/types.js'
import { setLightclawHomeOverride } from '../paths.js'
import { writeMemoryFile } from '../memory/auto-memory.js'
import { createSessionContext, runWithSessionContext } from '../session-context.js'
import { memoryReadTool } from './memory-read.js'

let tmpRoot = ''
let memoryDir = ''

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), 'lightclaw-memory-read-'))
  memoryDir = path.join(tmpRoot, 'memory', 'alice')
  setLightclawHomeOverride(path.join(tmpRoot, 'home'))
})

afterEach(async () => {
  setLightclawHomeOverride(undefined)
  await rm(tmpRoot, { recursive: true, force: true })
})

describe('MemoryRead readableDirs filtering', () => {
  it('lists only main root and shared memories for orchestrator roles', async () => {
    await seed()

    const result = await withMemorySession(mainRole(), () =>
      memoryReadTool.call({ action: 'list' }, undefined as never),
    )

    assert.equal(result.isError, undefined)
    // Bare basenames with an own/shared label — never a real tier path prefix
    // an agent could copy back into a rejecting MemoryWrite / MemoryRead.
    assert.match(result.output as string, /root-note\.md \(own\)/)
    assert.match(result.output as string, /shared-note\.md \(shared\)/)
    assert.doesNotMatch(result.output as string, /_shared\//)
    assert.doesNotMatch(result.output as string, /webSearcher-note\.md/)
  })

  it('allows worker roles to read root, shared, and own role-private paths', async () => {
    await seed()

    const list = await withMemorySession(webRole(), () =>
      memoryReadTool.call({ action: 'list' }, undefined as never),
    )
    assert.match(list.output as string, /webSearcher-note\.md \(own\)/)
    assert.match(list.output as string, /shared-note\.md \(shared\)/)
    assert.match(list.output as string, /root-note\.md \(shared\)/)
    assert.doesNotMatch(list.output as string, /_shared\//)
    assert.doesNotMatch(list.output as string, /webSearcher\//)

    const read = await withMemorySession(webRole(), () =>
      memoryReadTool.call({ action: 'read', filename: '_shared/shared-note' }, undefined as never),
    )
    assert.equal(read.isError, undefined)
    assert.match(read.output as string, /shared detail/)
  })

  it('denies worker roles from reading other role-private dirs', async () => {
    await seed()

    const result = await withMemorySession(workerRole('localExplorer'), () =>
      memoryReadTool.call({ action: 'read', filename: 'webSearcher/webSearcher-note' }, undefined as never),
    )

    assert.equal(result.isError, true)
    assert.match(result.output as string, /outside this role memory scope/)
  })

  it('lets internal roles read existing role directories', async () => {
    await seed()

    const result = await withMemorySession(internalRole('memoryExtractor'), () =>
      memoryReadTool.call({ action: 'list' }, undefined as never),
    )

    assert.match(result.output as string, /root-note\.md \(own\)/)
    assert.match(result.output as string, /shared-note\.md \(shared\)/)
    assert.match(result.output as string, /webSearcher-note\.md \(shared\)/)
    assert.doesNotMatch(result.output as string, /_shared\//)
  })
})

async function seed(): Promise<void> {
  await writeMemoryFile(memoryDir, memory('root-note', 'root detail'))
  await writeMemoryFile(path.join(memoryDir, '_shared'), memory('shared-note', 'shared detail'))
  await writeMemoryFile(path.join(memoryDir, 'webSearcher'), memory('webSearcher-note', 'webSearcher detail'))
}

function memory(filename: string, content: string) {
  return {
    filename,
    type: 'project' as const,
    description: `${filename} description`,
    content,
    mtimeMs: Date.now(),
  }
}

function withMemorySession<T>(currentRole: Role, fn: () => Promise<T>): Promise<T> {
  const ctx = createSessionContext({
    cwd: tmpRoot,
    model: 'claude-sonnet-4-6',
    sessionsDir: path.join(tmpRoot, 'sessions'),
    memoryDir,
    currentUserId: 'alice',
    currentRole,
    sessionId: 'memory-read-test',
  })
  return runWithSessionContext(ctx, fn)
}

function mainRole(): Role {
  return {
    agentType: 'main',
    kind: 'orchestrator',
    whenToUse: 'main',
    tools: ['*'],
    systemPrompt: 'system',
  }
}

function workerRole(agentType: string): Role {
  return {
    agentType,
    kind: 'worker',
    whenToUse: 'worker',
    tools: ['MemoryRead'],
    systemPrompt: 'system',
  }
}

function webRole(): Role {
  return workerRole('webSearcher')
}

function internalRole(agentType: string): Role {
  return {
    agentType,
    kind: 'internal',
    whenToUse: 'internal',
    tools: ['MemoryRead'],
    systemPrompt: 'system',
  }
}
