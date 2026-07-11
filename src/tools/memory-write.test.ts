import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { toJSONSchema } from 'zod/v4'

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
    const result = await withMemorySession(workerRole('webSearcher'), () => writeMemory('finding'))

    assert.equal(result.isError, undefined)
    await readFile(path.join(memoryDir, 'webSearcher', 'finding.md'), 'utf8')
    await readFile(path.join(memoryDir, 'webSearcher', 'MEMORY.md'), 'utf8')
  })

  it('denies traversal filenames and records audit', async () => {
    const result = await withMemorySession(workerRole('webSearcher'), () => writeMemory('../escape'))

    assert.equal(result.isError, true)
    assert.match(result.output as string, /within the memory directory/)
    const audit = await readAudit()
    assert.match(audit, /"role":"webSearcher"/)
    assert.match(audit, /"status":"denied"/)
  })

  it('heals a _shared/ prefix to the worker role-private dir instead of denying', async () => {
    const result = await withMemorySession(workerRole('webSearcher'), () =>
      memoryWriteTool.call(
        {
          filename: '_shared/2026-06-19-finding-by-webSearcher.md',
          type: 'project',
          description: 'Cross-role finding the agent tried to publish to _shared',
          content: 'Why: shared context\nHow to apply: reuse it.',
        },
        undefined as never,
      ),
    )

    assert.equal(result.isError, undefined)
    assert.match(result.output as string, /Ignored the "_shared\/" path prefix/)
    // Landed in the role's own L3 under the bare basename, not lost.
    await readFile(
      path.join(memoryDir, 'webSearcher', '2026-06-19-finding-by-webSearcher.md'),
      'utf8',
    )
    await assert.rejects(
      () => readFile(path.join(memoryDir, '_shared', '2026-06-19-finding-by-webSearcher.md'), 'utf8'),
      { code: 'ENOENT' },
    )
    const audit = await readAudit()
    // Audit keeps the original prefixed filename (intent) but records success.
    assert.match(audit, /"filename":"_shared\/2026-06-19-finding-by-webSearcher.md"/)
    assert.match(audit, /"status":"written"/)
  })

  it('heals an other-role prefix for main to the user memory root', async () => {
    const result = await withMemorySession(mainRole(), () =>
      memoryWriteTool.call(
        {
          filename: 'feishuSecretary/review-doc.md',
          type: 'project',
          description: 'A note main tried to file under another role',
          content: 'Why: useful\nHow to apply: keep it.',
        },
        undefined as never,
      ),
    )

    assert.equal(result.isError, undefined)
    await readFile(path.join(memoryDir, 'review-doc.md'), 'utf8')
    await assert.rejects(
      () => readFile(path.join(memoryDir, 'feishuSecretary', 'review-doc.md'), 'utf8'),
      { code: 'ENOENT' },
    )
  })

  it('writes internal memories to the user memory root', async () => {
    const result = await withMemorySession(internalRole('memoryExtractor'), () => writeMemory('extract-note'))

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

  it('rejects content over 6000 chars without writing the file', async () => {
    const oversized = 'x'.repeat(6001)
    const result = await withMemorySession(mainRole(), () =>
      memoryWriteTool.call(
        {
          filename: 'too-big',
          type: 'project',
          description: 'Oversized note',
          content: oversized,
        },
        undefined as never,
      ),
    )

    assert.equal(result.isError, true)
    assert.match(result.output as string, /6001 characters/)
    assert.match(result.output as string, /hard limit is 6000 \(over by 1\)/)
    assert.match(result.output as string, /split the material into multiple focused memories/)
    await assert.rejects(
      () => readFile(path.join(memoryDir, 'too-big.md'), 'utf8'),
      { code: 'ENOENT' },
    )
    const audit = await readAudit()
    assert.match(audit, /"status":"denied"/)
    assert.match(audit, /content exceeds 6000 chars/)
  })

  it('declares the content limit in the schema so agents see it before writing', () => {
    // The 2026-07-07 prod thrash (5 blind trim-and-retry cycles, the 5th
    // still 2 chars over) happened because the limit only surfaced in the
    // deny message. The schema description is the up-front disclosure.
    assert.ok(memoryWriteTool.inputSchema)
    const schema = toJSONSchema(memoryWriteTool.inputSchema) as unknown as {
      properties: { content: { description?: string } }
    }
    const description = schema.properties.content.description ?? ''
    assert.match(description, /max 6000 characters/)
    assert.match(description, /split it into multiple focused memories/)
  })

  it('lets fork-like nested contexts override a parent worker role', async () => {
    const parent = createSessionContext({
      cwd: tmpRoot,
      model: 'claude-sonnet-4-6',
      sessionsDir: path.join(tmpRoot, 'sessions'),
      memoryDir,
      currentUserId: 'alice',
      currentRole: workerRole('webSearcher'),
      sessionId: 'memory-write-parent',
    })
    const child = {
      ...parent,
      currentRole: internalRole('memoryExtractor'),
      sessionId: 'memory-write-child',
    }

    const result = await runWithSessionContext(parent, () =>
      runWithSessionContext(child, () => writeMemory('fork-extract-note')),
    )

    assert.equal(result.isError, undefined)
    await readFile(path.join(memoryDir, 'fork-extract-note.md'), 'utf8')
    await assert.rejects(
      () => readFile(path.join(memoryDir, 'webSearcher', 'fork-extract-note.md'), 'utf8'),
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
