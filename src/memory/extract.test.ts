import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import type { LightClawConfig } from '../config.js'
import { memoryExtractorPrompt } from '../agents/bundled/memoryExtractor.js'
import { getAgent, getMainRole } from '../agents/registry.js'
import { persistForkTranscript } from '../agents/fork-transcript.js'
import { createAssistantMessage, createUserMessage } from '../messages.js'
import type { MemoryEntry } from './types.js'
import {
  _resetExtractionStateForTest,
  _setRunSubagentForTest,
  buildExtractPrompt,
  collectExistingMemoriesForRole,
  drainPendingExtraction,
  executeExtraction,
  hasMemoryWritesSince,
  isExtractionInProgressFor,
  messageToText,
  setExtractionInProgressForTest,
  triggerForkExtract,
} from './extract.js'
import { writeMemoryFile } from './auto-memory.js'

const dummyConfig = {
  defaultModel: 'claude-sonnet-4-6',
  autoMemory: true,
  sessionsDir: path.join(os.tmpdir(), 'lightclaw-test-sessions'),
} as unknown as LightClawConfig

function memory(filename: string): MemoryEntry {
  return {
    filename,
    type: 'project',
    description: 'A project convention',
    content: 'Why: useful\nHow to apply: remember it',
    mtimeMs: 1,
  }
}

test('messageToText renders user text', () => {
  assert.equal(messageToText(createUserMessage('hello', null, 10)), '[user]\nhello')
})

test('messageToText renders assistant text and tool_use', () => {
  const message = createAssistantMessage({
    content: [
      { type: 'text', text: 'done' },
      { type: 'tool_use', id: 't1', name: 'Read', input: { path: 'a.txt' } },
    ],
    stopReason: 'tool_use',
    usage: {},
    timestamp: 20,
  })
  assert.match(messageToText(message), /Tool use: Read/)
})

test('buildExtractPrompt invokes MemoryWrite and renders existing memories', () => {
  const prompt = buildExtractPrompt(
    [createUserMessage('remember my preference', null, 10)],
    [memory('project-style.md')],
  )
  assert.match(prompt, /MemoryWrite/)
  assert.match(prompt, /project-style\.md/)
})

test('memoryExtractor system prompt bans JSON-text output (regression guard)', () => {
  // Output discipline lives in the role's system prompt, not in the
  // per-call user message (which previously duplicated this rule). The
  // historical bug was extraction agents emitting JSON in text instead
  // of calling MemoryWrite; this assertion pins the discipline at its
  // current source of truth.
  assert.match(memoryExtractorPrompt, /Do NOT emit memory contents as JSON/)
})

test('hasMemoryWritesSince detects assistant MemoryWrite tool_use', () => {
  const message = createAssistantMessage({
    content: [
      {
        type: 'tool_use',
        id: 't1',
        name: 'MemoryWrite',
        input: { filename: 'user.md' },
      },
    ],
    stopReason: 'tool_use',
    usage: {},
    timestamp: 20,
  })
  assert.equal(hasMemoryWritesSince([message], 10), true)
})

test('hasMemoryWritesSince ignores old MemoryWrite tool_use', () => {
  const message = createAssistantMessage({
    content: [
      {
        type: 'tool_use',
        id: 't1',
        name: 'MemoryWrite',
        input: { filename: 'user.md' },
      },
    ],
    stopReason: 'tool_use',
    usage: {},
    timestamp: 5,
  })
  assert.equal(hasMemoryWritesSince([message], 10), false)
})

test('per-role extraction passes currentRoleOverride to memoryExtractor', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'lightclaw-extract-'))
  const webRole = getAgent('webSearcher')
  assert.ok(webRole)
  const messages = [createUserMessage('remember this webSearcher result', null, 10)]
  const calls: Array<Parameters<typeof executeExtraction>[0]> = []
  try {
    _resetExtractionStateForTest()
    _setRunSubagentForTest(async params => {
      calls.push({
        messages,
        lastExtractedAt: 0,
        memoryDir: tempDir,
        canonicalUser: 'alice',
        config: dummyConfig,
        ownerRole: params.currentRoleOverride,
      })
      return { kind: 'success', finalText: 'ok', stopReason: 'end_turn' }
    })

    await executeExtraction({
      messages,
      lastExtractedAt: 0,
      memoryDir: tempDir,
      canonicalUser: 'alice',
      config: dummyConfig,
      ownerRole: webRole,
    })

    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.ownerRole?.agentType, 'webSearcher')
  } finally {
    _setRunSubagentForTest()
    _resetExtractionStateForTest()
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('triggerForkExtract treats a marker-less transcript as fully fork-own', async () => {
  // No explicit forkContextEndIndex → defaults to 0 → forkContextSlice is
  // empty, forkOwnSlice is the full message list. Verifies the Option C
  // legacy / zero-context path.
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'lightclaw-extract-'))
  const webRole = getAgent('webSearcher')
  assert.ok(webRole)
  const messages = [createUserMessage('webSearcher transcript input', null, 10)]
  const forkTranscriptPath = path.join(tempDir, 'parent', 'forks', 'webSearcher-test.jsonl')
  const seen: {
    role?: string
    promptIncludesText?: boolean
  } = {}
  try {
    await persistForkTranscript(forkTranscriptPath, messages)
    _resetExtractionStateForTest()
    _setRunSubagentForTest(async params => {
      seen.role = params.currentRoleOverride?.agentType
      seen.promptIncludesText = params.prompt.includes('webSearcher transcript input')
      return { kind: 'success', finalText: 'ok', stopReason: 'end_turn' }
    })

    await triggerForkExtract({
      canonicalUser: 'alice',
      ownerRole: webRole,
      forkTranscriptPath,
      memoryDir: tempDir,
      config: dummyConfig,
    })

    // owning role is webSearcher (currentRole physical binding)
    assert.equal(seen.role, 'webSearcher')
    // fork-own messages still drive the extract prompt body
    assert.equal(seen.promptIncludesText, true)
  } finally {
    _setRunSubagentForTest()
    _resetExtractionStateForTest()
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('triggerForkExtract slices fork-own vs parent prefix using the marker', async () => {
  // The marker (forkContextEndIndex=2) tells extract that the first 2
  // messages came from a legacy inherited parent prefix and the last 2 are
  // the worker's own user prompt + assistant turn. Extract analyzes only the
  // worker-owned slice and no longer injects the hidden parent prefix.
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'lightclaw-extract-'))
  const webRole = getAgent('webSearcher')
  assert.ok(webRole)
  const parentContext = [
    createUserMessage('parent DM line one', null, 1),
    createUserMessage('parent DM line two', null, 2),
  ]
  const forkOwn = [
    createUserMessage('webSearcher fork prompt: query X', null, 10),
    createAssistantMessage({
      content: [{ type: 'text', text: 'webSearcher answer about X' }],
      stopReason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
      parentUuid: null,
      timestamp: 11,
    }),
  ]
  const allMessages = [...parentContext, ...forkOwn]
  const forkTranscriptPath = path.join(tempDir, 'parent', 'forks', 'webSearcher-slice.jsonl')
  const seen: {
    promptHasParent?: boolean
    promptHasOwn?: boolean
  } = {}
  try {
    await persistForkTranscript(
      forkTranscriptPath,
      allMessages,
      parentContext.length,
    )
    _resetExtractionStateForTest()
    _setRunSubagentForTest(async params => {
      seen.promptHasParent = params.prompt.includes('parent DM line one')
      seen.promptHasOwn = params.prompt.includes('webSearcher fork prompt: query X')
      return { kind: 'success', finalText: 'ok', stopReason: 'end_turn' }
    })

    await triggerForkExtract({
      canonicalUser: 'alice',
      ownerRole: webRole,
      forkTranscriptPath,
      memoryDir: tempDir,
      config: dummyConfig,
    })

    // Extract prompt body should NOT see the parent context (it would
    // dilute / mis-attribute signal); only fork-own messages are rendered
    assert.equal(seen.promptHasParent, false)
    assert.equal(seen.promptHasOwn, true)
  } finally {
    _setRunSubagentForTest()
    _resetExtractionStateForTest()
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('isExtractionInProgressFor keeps per-user dream mutex semantics across role keys', () => {
  const memoryDir = '/tmp/lightclaw-memory'
  _resetExtractionStateForTest()
  assert.equal(isExtractionInProgressFor(memoryDir), false)
  setExtractionInProgressForTest(memoryDir, true)
  assert.equal(isExtractionInProgressFor(memoryDir), true)
  setExtractionInProgressForTest(memoryDir, false)
  assert.equal(isExtractionInProgressFor(memoryDir), false)
  assert.equal(getMainRole().agentType, 'main')
})

test('collectExistingMemoriesForRole gives main root plus shared, excluding role-private dirs', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'lightclaw-extract-'))
  try {
    await writeMemoryFile(tempDir, memory('root-note.md'))
    await writeMemoryFile(path.join(tempDir, '_shared'), memory('shared-note.md'))
    await writeMemoryFile(path.join(tempDir, 'webSearcher'), memory('webSearcher-note.md'))

    const entries = await collectExistingMemoriesForRole(getMainRole(), tempDir)

    assert.deepEqual(entries.map(entry => entry.filename), [
      '_shared/shared-note.md',
      'root-note.md',
    ])
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('collectExistingMemoriesForRole gives webSearcher root plus shared plus private memory', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'lightclaw-extract-'))
  const webRole = getAgent('webSearcher')
  assert.ok(webRole)
  try {
    await writeMemoryFile(tempDir, memory('root-note.md'))
    await writeMemoryFile(path.join(tempDir, '_shared'), memory('same-name.md'))
    await writeMemoryFile(path.join(tempDir, 'webSearcher'), memory('same-name.md'))

    const entries = await collectExistingMemoriesForRole(webRole, tempDir)

    assert.deepEqual(entries.map(entry => entry.filename), [
      '_shared/same-name.md',
      'root-note.md',
      'webSearcher/same-name.md',
    ])
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('drainPendingExtraction waits for multiple active role instances', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'lightclaw-extract-'))
  const webRole = getAgent('webSearcher')
  assert.ok(webRole)
  const mainRole = getMainRole()
  const messages = [createUserMessage('drain me', null, 10)]
  const releaseFns: Array<() => void> = []
  try {
    _resetExtractionStateForTest()
    _setRunSubagentForTest(async () => {
      await new Promise<void>(resolve => {
        releaseFns.push(resolve)
      })
      return { kind: 'success', finalText: 'ok', stopReason: 'end_turn' }
    })
    const config = {
      ...dummyConfig,
      sessionsDir: path.join(tempDir, 'sessions'),
    } as LightClawConfig

    const mainTask = executeExtraction({
      messages,
      lastExtractedAt: 0,
      memoryDir: tempDir,
      canonicalUser: 'alice',
      config,
      ownerRole: mainRole,
    })
    const webTask = executeExtraction({
      messages,
      lastExtractedAt: 0,
      memoryDir: tempDir,
      canonicalUser: 'alice',
      config,
      ownerRole: webRole,
    })
    await waitFor(() => releaseFns.length === 2)
    assert.equal(releaseFns.length, 2)

    let drained = false
    const drainTask = drainPendingExtraction(1_000).then(() => {
      drained = true
    })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(drained, false)

    for (const release of releaseFns) release()
    await Promise.all([mainTask, webTask, drainTask])
    assert.equal(drained, true)
  } finally {
    _setRunSubagentForTest()
    _resetExtractionStateForTest()
    await rm(tempDir, { recursive: true, force: true })
  }
})

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.equal(predicate(), true)
}
