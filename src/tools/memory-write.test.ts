import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import type { Role } from '../agents/types.js'
import { setLightclawHomeOverride } from '../paths.js'
import { createSessionContext, runWithSessionContext } from '../session-context.js'
import { memoryWriteTool } from './memory-write.js'

let tmpRoot = ''
let memoryDir = ''
let lightclawHome = ''

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), 'lightclaw-memory-write-'))
  memoryDir = path.join(tmpRoot, 'memory', 'alice')
  lightclawHome = path.join(tmpRoot, 'home')
  setLightclawHomeOverride(lightclawHome)
})

afterEach(async () => {
  setLightclawHomeOverride(undefined)
  await rm(tmpRoot, { recursive: true, force: true })
})

describe('MemoryWrite currentRole binding', () => {
  it('writes main memories to the user memory root', async () => {
    const result = await withMemorySession(mainRole(), () => writeMemory('main-note'))

    assert.equal(result.isError, undefined)
    const content = await readFile(path.join(memoryDir, 'main-note.md'), 'utf8')
    assert.match(content, /description: Main note/)
    assert.match(await readAudit(), /"role":"main"/)
    assert.match(await readAudit(), /"status":"written"/)
  })

  it('writes worker memories to the role-private directory lazily', async () => {
    const result = await withMemorySession(workerRole('web'), () => writeMemory('finding'))

    assert.equal(result.isError, undefined)
    await readFile(path.join(memoryDir, 'web', 'finding.md'), 'utf8')
    await readFile(path.join(memoryDir, 'web', 'MEMORY.md'), 'utf8')
  })

  it('denies traversal filenames and records audit', async () => {
    const result = await withMemorySession(workerRole('web'), () => writeMemory('../escape'))

    assert.equal(result.isError, true)
    assert.match(result.output as string, /within the memory directory/)
    const audit = await readAudit()
    assert.match(audit, /"role":"web"/)
    assert.match(audit, /"status":"denied"/)
  })

  it('writes internal memories to the user memory root', async () => {
    const result = await withMemorySession(internalRole('extract_memories'), () => writeMemory('extract-note'))

    assert.equal(result.isError, undefined)
    await readFile(path.join(memoryDir, 'extract-note.md'), 'utf8')
  })

  it('falls back to main when currentRole is missing', async () => {
    const ctx = createSessionContext({
      cwd: tmpRoot,
      model: 'claude-sonnet-4-6',
      sessionsDir: path.join(tmpRoot, 'sessions'),
      memoryDir,
      currentUserId: 'alice',
      sessionId: 'memory-write-test',
    })

    const result = await runWithSessionContext(ctx, () => writeMemory('fallback-note'))

    assert.equal(result.isError, undefined)
    await readFile(path.join(memoryDir, 'fallback-note.md'), 'utf8')
  })

  it('lets fork-like nested contexts override a parent worker role', async () => {
    const parent = createSessionContext({
      cwd: tmpRoot,
      model: 'claude-sonnet-4-6',
      sessionsDir: path.join(tmpRoot, 'sessions'),
      memoryDir,
      currentUserId: 'alice',
      currentRole: workerRole('web'),
      sessionId: 'memory-write-parent',
    })
    const child = {
      ...parent,
      currentRole: internalRole('extract_memories'),
      sessionId: 'memory-write-child',
    }

    const result = await runWithSessionContext(parent, () =>
      runWithSessionContext(child, () => writeMemory('fork-extract-note')),
    )

    assert.equal(result.isError, undefined)
    await readFile(path.join(memoryDir, 'fork-extract-note.md'), 'utf8')
    await assert.rejects(
      () => readFile(path.join(memoryDir, 'web', 'fork-extract-note.md'), 'utf8'),
      { code: 'ENOENT' },
    )
  })
})

function writeMemory(filename: string) {
  return memoryWriteTool.call({
    filename,
    type: 'project',
    description: 'Main note',
    content: 'Why: useful detail\nHow to apply: keep it available.',
  }, undefined as never)
}

function withMemorySession<T>(currentRole: Role, fn: () => Promise<T>): Promise<T> {
  const ctx = createSessionContext({
    cwd: tmpRoot,
    model: 'claude-sonnet-4-6',
    sessionsDir: path.join(tmpRoot, 'sessions'),
    memoryDir,
    currentUserId: 'alice',
    currentRole,
    sessionId: 'memory-write-test',
  })
  return runWithSessionContext(ctx, fn)
}

async function readAudit(): Promise<string> {
  const day = new Date().toISOString().slice(0, 10)
  return readFile(path.join(lightclawHome, 'audit', 'memory-writes', `${day}.jsonl`), 'utf8')
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
    tools: ['MemoryWrite'],
    systemPrompt: 'system',
  }
}

function internalRole(agentType: string): Role {
  return {
    agentType,
    kind: 'internal',
    whenToUse: 'internal',
    tools: ['MemoryWrite'],
    systemPrompt: 'system',
  }
}
