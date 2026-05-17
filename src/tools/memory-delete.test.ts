import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { createSessionContext, runWithSessionContext } from '../session-context.js'
import { memoryDeleteTool } from './memory-delete.js'

let tmpRoot = ''
let memoryDir = ''

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), 'lightclaw-memory-delete-'))
  memoryDir = path.join(tmpRoot, 'memory', 'alice')
  await mkdir(path.join(memoryDir, 'webSearcher'), { recursive: true })
  await writeFile(path.join(memoryDir, 'webSearcher', 'a.md'), 'a', 'utf8')
})

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true })
})

describe('MemoryDelete', () => {
  it('deletes an existing file', async () => {
    const result = await withMemorySession(() =>
      memoryDeleteTool.call({ path: 'webSearcher/a.md' }, undefined as never),
    )

    assert.equal(result.isError, undefined)
    assert.equal(result.output, 'Deleted webSearcher/a.md')
    await assert.rejects(stat(path.join(memoryDir, 'webSearcher', 'a.md')), { code: 'ENOENT' })
  })

  it('is idempotent for missing files', async () => {
    const result = await withMemorySession(() =>
      memoryDeleteTool.call({ path: 'webSearcher/missing.md' }, undefined as never),
    )

    assert.equal(result.isError, undefined)
    assert.equal(result.output, 'No-op (file did not exist)')
  })

  it('rejects traversal outside memoryDir', async () => {
    const result = await withMemorySession(() =>
      memoryDeleteTool.call({ path: '../a.md' }, undefined as never),
    )

    assert.equal(result.isError, true)
    assert.equal(result.output, 'path resolves outside memoryDir')
  })

  it('rejects directory deletion', async () => {
    const result = await withMemorySession(() =>
      memoryDeleteTool.call({ path: 'webSearcher' }, undefined as never),
    )

    assert.equal(result.isError, true)
    assert.equal(result.output, 'cannot delete a directory; this tool only deletes files')
  })

  it('rejects deleting MEMORY.md', async () => {
    await writeFile(path.join(memoryDir, 'webSearcher', 'MEMORY.md'), 'index', 'utf8')
    const result = await withMemorySession(() =>
      memoryDeleteTool.call({ path: 'webSearcher/MEMORY.md' }, undefined as never),
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
