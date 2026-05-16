import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { createSessionContext, runWithSessionContext } from '../session-context.js'
import { memoryMoveTool } from './memory-move.js'

let tmpRoot = ''
let memoryDir = ''

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), 'lightclaw-memory-move-'))
  memoryDir = path.join(tmpRoot, 'memory', 'alice')
  await mkdir(path.join(memoryDir, 'web'), { recursive: true })
  await writeFile(path.join(memoryDir, 'web', 'a.md'), 'a', 'utf8')
})

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true })
})

describe('MemoryMove', () => {
  it('renames within the same directory', async () => {
    const result = await withMemorySession(() =>
      memoryMoveTool.call({ from: 'web/a.md', to: 'web/b.md' }, undefined as never),
    )

    assert.equal(result.isError, undefined)
    assert.equal(result.output, 'Moved web/a.md to web/b.md')
    assert.equal(await readFile(path.join(memoryDir, 'web', 'b.md'), 'utf8'), 'a')
  })

  it('moves across directories and creates destination parent lazily', async () => {
    const result = await withMemorySession(() =>
      memoryMoveTool.call({
        from: 'web/a.md',
        to: '_shared/2026-05-16-a-by-web.md',
      }, undefined as never),
    )

    assert.equal(result.isError, undefined)
    assert.equal(
      await readFile(path.join(memoryDir, '_shared', '2026-05-16-a-by-web.md'), 'utf8'),
      'a',
    )
  })

  it('rejects traversal in source', async () => {
    const result = await withMemorySession(() =>
      memoryMoveTool.call({ from: '../a.md', to: 'web/b.md' }, undefined as never),
    )

    assert.equal(result.isError, true)
    assert.equal(result.output, 'path resolves outside memoryDir')
  })

  it('rejects traversal in destination', async () => {
    const result = await withMemorySession(() =>
      memoryMoveTool.call({ from: 'web/a.md', to: '../b.md' }, undefined as never),
    )

    assert.equal(result.isError, true)
    assert.equal(result.output, 'path resolves outside memoryDir')
  })

  it('reports missing source', async () => {
    const result = await withMemorySession(() =>
      memoryMoveTool.call({ from: 'web/missing.md', to: 'web/b.md' }, undefined as never),
    )

    assert.equal(result.isError, true)
    assert.equal(result.output, 'source file does not exist')
  })

  it('rejects moving directories', async () => {
    const result = await withMemorySession(() =>
      memoryMoveTool.call({ from: 'web', to: '_shared/web' }, undefined as never),
    )

    assert.equal(result.isError, true)
    assert.equal(result.output, 'source must be a file')
  })

  it('reports destination conflict', async () => {
    await writeFile(path.join(memoryDir, 'web', 'b.md'), 'b', 'utf8')
    const result = await withMemorySession(() =>
      memoryMoveTool.call({ from: 'web/a.md', to: 'web/b.md' }, undefined as never),
    )

    assert.equal(result.isError, true)
    assert.equal(result.output, 'destination already exists')
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
