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
  await mkdir(path.join(memoryDir, 'webSearcher'), { recursive: true })
  await writeFile(path.join(memoryDir, 'webSearcher', 'a.md'), 'a', 'utf8')
})

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true })
})

describe('MemoryMove', () => {
  it('renames within the same directory', async () => {
    const result = await withMemorySession(() =>
      memoryMoveTool.call({ from: 'webSearcher/a.md', to: 'webSearcher/b.md' }, undefined as never),
    )

    assert.equal(result.isError, undefined)
    assert.equal(result.output, 'Moved webSearcher/a.md to webSearcher/b.md')
    assert.equal(await readFile(path.join(memoryDir, 'webSearcher', 'b.md'), 'utf8'), 'a')
  })

  it('moves across directories and creates destination parent lazily', async () => {
    const result = await withMemorySession(() =>
      memoryMoveTool.call({
        from: 'webSearcher/a.md',
        to: '_shared/2026-05-16-a-by-webSearcher.md',
      }, undefined as never),
    )

    assert.equal(result.isError, undefined)
    assert.equal(
      await readFile(path.join(memoryDir, '_shared', '2026-05-16-a-by-webSearcher.md'), 'utf8'),
      'a',
    )
  })

  it('rejects traversal in source', async () => {
    const result = await withMemorySession(() =>
      memoryMoveTool.call({ from: '../a.md', to: 'webSearcher/b.md' }, undefined as never),
    )

    assert.equal(result.isError, true)
    assert.equal(result.output, 'path resolves outside memoryDir')
  })

  it('rejects traversal in destination', async () => {
    const result = await withMemorySession(() =>
      memoryMoveTool.call({ from: 'webSearcher/a.md', to: '../b.md' }, undefined as never),
    )

    assert.equal(result.isError, true)
    assert.equal(result.output, 'path resolves outside memoryDir')
  })

  it('reports missing source', async () => {
    const result = await withMemorySession(() =>
      memoryMoveTool.call({ from: 'webSearcher/missing.md', to: 'webSearcher/b.md' }, undefined as never),
    )

    assert.equal(result.isError, true)
    assert.equal(result.output, 'source file does not exist')
  })

  it('rejects moving directories', async () => {
    const result = await withMemorySession(() =>
      memoryMoveTool.call({ from: 'webSearcher', to: '_shared/webSearcher' }, undefined as never),
    )

    assert.equal(result.isError, true)
    assert.equal(result.output, 'source must be a file')
  })

  it('reports destination conflict', async () => {
    await writeFile(path.join(memoryDir, 'webSearcher', 'b.md'), 'b', 'utf8')
    const result = await withMemorySession(() =>
      memoryMoveTool.call({ from: 'webSearcher/a.md', to: 'webSearcher/b.md' }, undefined as never),
    )

    assert.equal(result.isError, true)
    assert.equal(result.output, 'destination already exists')
  })

  it('rejects moving MEMORY.md as source', async () => {
    await writeFile(path.join(memoryDir, 'webSearcher', 'MEMORY.md'), 'index', 'utf8')
    const result = await withMemorySession(() =>
      memoryMoveTool.call({ from: 'webSearcher/MEMORY.md', to: 'webSearcher/saved.md' }, undefined as never),
    )

    assert.equal(result.isError, true)
    assert.match(result.output as string, /MEMORY\.md is framework-managed/)
  })

  it('rejects moving onto MEMORY.md as destination', async () => {
    const result = await withMemorySession(() =>
      memoryMoveTool.call({ from: 'webSearcher/a.md', to: 'webSearcher/MEMORY.md' }, undefined as never),
    )

    assert.equal(result.isError, true)
    assert.match(result.output as string, /MEMORY\.md is framework-managed/)
  })

  it('records a memory-writes audit row with movedFrom on successful move (2026-05-28 audit coverage)', async () => {
    const auditDir = path.join(tmpRoot, 'audit')
    const saved = process.env.LIGHTCLAW_AUDIT_DIR
    process.env.LIGHTCLAW_AUDIT_DIR = auditDir
    try {
      await withMemorySession(() =>
        memoryMoveTool.call(
          { from: 'webSearcher/a.md', to: '_shared/2026-05-16-a-by-webSearcher.md' },
          undefined as never,
        ),
      )
      const day = new Date().toISOString().slice(0, 10)
      // Pre-fix: MemoryMove wrote nothing here → ENOENT.
      const raw = await readFile(path.join(auditDir, 'memory-writes', `${day}.jsonl`), 'utf8')
      const rows = raw.trim().split('\n').map(line => JSON.parse(line))
      const move = rows.find(r => r.operation === 'move' && r.status === 'moved')
      assert.ok(move, 'expected a moved audit row')
      assert.equal(move.movedFrom, 'webSearcher/a.md')
      assert.match(String(move.targetPath), /_shared\/2026-05-16-a-by-webSearcher\.md$/)
      assert.equal(move.sourceTier, 'L2')
    } finally {
      if (saved === undefined) delete process.env.LIGHTCLAW_AUDIT_DIR
      else process.env.LIGHTCLAW_AUDIT_DIR = saved
    }
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
