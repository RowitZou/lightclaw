import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import type { Role } from '../agents/types.js'
import { loadMemoryIndex, scanMemoryFilesInDirs, writeMemoryFile } from './auto-memory.js'
import { resolveReadableMemoryDirsForRole } from './scope.js'

let tmpRoot = ''
let memoryDir = ''

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), 'lightclaw-auto-memory-'))
  memoryDir = path.join(tmpRoot, 'memory', 'alice')
})

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true })
})

describe('role-scoped memory indexes', () => {
  it('treats missing role-private directories as empty', async () => {
    assert.deepEqual(
      await scanMemoryFilesInDirs(memoryDir, [path.join(memoryDir, 'webSearcher')]),
      [],
    )
  })

  it('prefixes shared and role-private index entries for orchestrator and worker views', async () => {
    await seed()

    const mainIndex = await loadMemoryIndex(memoryDir, mainRole())
    assert.match(mainIndex, /root-note\.md/)
    assert.match(mainIndex, /_shared\/shared-note\.md/)
    assert.doesNotMatch(mainIndex, /webSearcher\/webSearcher-note\.md/)

    const webIndex = await loadMemoryIndex(memoryDir, webRole())
    assert.match(webIndex, /webSearcher\/webSearcher-note\.md/)
    assert.match(webIndex, /_shared\/shared-note\.md/)
    assert.match(webIndex, /root-note\.md/)
  })

  it('returns three-layer readable memories for default worker roles', async () => {
    await seed()
    const resolved = await resolveReadableMemoryDirsForRole(workerRole('localExplorer'), memoryDir)

    assert.deepEqual(resolved.readableDirs, [
      memoryDir,
      path.join(memoryDir, '_shared'),
      path.join(memoryDir, 'localExplorer'),
    ])
    const index = await loadMemoryIndex(memoryDir, workerRole('localExplorer'))
    assert.match(index, /root-note\.md/)
    assert.match(index, /_shared\/shared-note\.md/)
    assert.doesNotMatch(index, /webSearcher\/webSearcher-note\.md/)
    assert.deepEqual(
      new Set((await scanMemoryFilesInDirs(memoryDir, resolved.readableDirs)).map(entry => entry.filename)),
      new Set(['root-note.md', '_shared/shared-note.md']),
    )
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
