import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { createSessionContext, runWithSessionContext } from '../session-context.js'
import { memoryWriteAtTool } from './memory-write-at.js'

let tmpRoot = ''
let memoryDir = ''

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), 'lightclaw-memory-write-at-'))
  memoryDir = path.join(tmpRoot, 'memory', 'alice')
})

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true })
})

describe('MemoryWriteAt', () => {
  it('writes under _shared and creates the parent directory lazily', async () => {
    const result = await withMemorySession(() =>
      memoryWriteAtTool.call({
        path: '_shared/finding.md',
        type: 'project',
        description: 'A shared finding',
        content: 'Why: useful\nHow to apply: share it',
      }, undefined as never),
    )

    assert.equal(result.isError, undefined)
    assert.equal(result.output, 'Wrote to _shared/finding.md')
    const content = await readFile(path.join(memoryDir, '_shared', 'finding.md'), 'utf8')
    assert.match(content, /type: project/)
    assert.match(content, /description: A shared finding/)
    assert.match(content, /Why: useful/)
    const index = await readFile(path.join(memoryDir, '_shared', 'MEMORY.md'), 'utf8')
    assert.match(index, /finding\.md/)
  })

  it('writes under a role-private directory', async () => {
    const result = await withMemorySession(() =>
      memoryWriteAtTool.call({
        path: 'web/research-note',
        type: 'reference',
        description: 'A web note',
        content: 'A durable web research detail.',
      }, undefined as never),
    )

    assert.equal(result.isError, undefined)
    assert.equal(result.output, 'Wrote to web/research-note.md')
    await readFile(path.join(memoryDir, 'web', 'research-note.md'), 'utf8')
  })

  it('rejects traversal outside memoryDir', async () => {
    const result = await withMemorySession(() =>
      memoryWriteAtTool.call({
        path: '../escape.md',
        type: 'project',
        description: 'An escape attempt',
        content: 'This should not be written.',
      }, undefined as never),
    )

    assert.equal(result.isError, true)
    assert.equal(result.output, 'path resolves outside memoryDir')
  })

  it('rejects normalized traversal outside memoryDir', async () => {
    const result = await withMemorySession(() =>
      memoryWriteAtTool.call({
        path: '_shared/../../escape.md',
        type: 'project',
        description: 'An escape attempt',
        content: 'This should not be written.',
      }, undefined as never),
    )

    assert.equal(result.isError, true)
    assert.equal(result.output, 'path resolves outside memoryDir')
  })

  it('rejects absolute paths', async () => {
    const result = await withMemorySession(() =>
      memoryWriteAtTool.call({
        path: path.join(tmpRoot, 'abs.md'),
        type: 'project',
        description: 'An absolute path',
        content: 'This should not be written.',
      }, undefined as never),
    )

    assert.equal(result.isError, true)
    assert.equal(result.output, 'path resolves outside memoryDir')
  })

  it('rejects writing MEMORY.md directly', async () => {
    const result = await withMemorySession(() =>
      memoryWriteAtTool.call({
        path: '_shared/MEMORY.md',
        type: 'project',
        description: 'Manual index attempt',
        content: 'This should not be written.',
      }, undefined as never),
    )

    assert.equal(result.isError, true)
    assert.match(result.output as string, /MEMORY\.md is framework-managed/)
  })
})

function withMemorySession<T>(fn: () => Promise<T>): Promise<T> {
  const ctx = createSessionContext({
    cwd: tmpRoot,
    model: 'claude-sonnet-4-6',
    sessionsDir: path.join(tmpRoot, 'sessions'),
    memoryDir,
    currentUserId: 'alice',
    sessionId: 'memory-tool-test',
  })
  return runWithSessionContext(ctx, fn)
}
