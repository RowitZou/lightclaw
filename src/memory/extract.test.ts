import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import type { LightClawConfig } from '../config.js'
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
import {
  createAutoDreamCanUseTool,
  createAutoMemCanUseTool,
  getBashHead,
  isReadOnlyBash,
} from './auto-mem-can-use-tool.js'
import { writeMemoryFile } from './auto-memory.js'
import type { Tool } from '../tool.js'

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

function tool(name: string): Tool {
  return {
    name,
    description: name,
    source: 'builtin',
    domain: 'host',
    riskLevel: 'safe',
    async call() {
      return { output: 'ok' }
    },
    formatResult(output, toolUseId) {
      return {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: String(output),
      }
    },
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

test('buildExtractPrompt instructs tool-use and not JSON output', () => {
  const prompt = buildExtractPrompt(
    [createUserMessage('remember my preference', null, 10)],
    [memory('project-style.md')],
  )
  assert.match(prompt, /MemoryWrite/)
  assert.match(prompt, /Do not output JSON/)
  assert.match(prompt, /project-style\.md/)
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

test('getBashHead skips env prefixes and path dirs', () => {
  assert.equal(getBashHead('LANG=C /usr/bin/grep foo file'), 'grep')
})

test('isReadOnlyBash accepts read-only heads', () => {
  assert.equal(isReadOnlyBash({ command: 'cat note.md' }), true)
})

test('isReadOnlyBash rejects mutating heads', () => {
  assert.equal(isReadOnlyBash({ command: 'rm -rf /tmp/a' }), false)
})

test('auto memory tool gate allows MemoryWrite', async () => {
  const gate = createAutoMemCanUseTool('/tmp/memory')
  assert.deepEqual(await gate(tool('MemoryWrite'), {}), { behavior: 'allow' })
})

test('auto memory tool gate still allows read-only Bash for extraction', async () => {
  const gate = createAutoMemCanUseTool('/tmp/memory')
  assert.deepEqual(await gate(tool('Bash'), { command: 'grep foo MEMORY.md' }), { behavior: 'allow' })
})

test('auto memory tool gate denies Edit', async () => {
  const gate = createAutoMemCanUseTool('/tmp/memory')
  const decision = await gate(tool('Edit'), {})
  assert.equal(decision.behavior, 'deny')
})

test('autoDream tool gate allows only explicit memory curation tools and reads', async () => {
  const gate = createAutoDreamCanUseTool('/tmp/memory')
  for (const name of ['MemoryRead', 'MemoryWriteAt', 'MemoryMove', 'MemoryDelete', 'Read', 'Grep', 'Glob']) {
    assert.equal((await gate(tool(name), {})).behavior, 'allow')
  }

  assert.deepEqual(await gate(tool('Bash'), { command: 'cat MEMORY.md' }), {
    behavior: 'deny',
    reason: 'autoDream may not run shell commands.',
  })
  assert.deepEqual(await gate(tool('MemoryWrite'), {}), {
    behavior: 'deny',
    reason: 'autoDream cannot use MemoryWrite.',
  })
  assert.equal((await gate(tool('Edit'), {})).behavior, 'deny')
})

test('per-role extraction passes currentRoleOverride and fork transcript context to extract_memories', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'lightclaw-extract-'))
  const webRole = getAgent('web')
  assert.ok(webRole)
  const messages = [createUserMessage('remember this web result', null, 10)]
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
        forkContextMessages: params.forkContextMessagesOverride,
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
      forkContextMessages: messages,
    })

    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.ownerRole?.agentType, 'web')
    assert.deepEqual(calls[0]?.forkContextMessages, messages)
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
  const webRole = getAgent('web')
  assert.ok(webRole)
  const messages = [createUserMessage('web transcript input', null, 10)]
  const forkTranscriptPath = path.join(tempDir, 'parent', 'forks', 'web-test.jsonl')
  const seen: {
    contextOverride?: unknown
    role?: string
    promptIncludesText?: boolean
  } = {}
  try {
    await persistForkTranscript(forkTranscriptPath, messages)
    _resetExtractionStateForTest()
    _setRunSubagentForTest(async params => {
      seen.contextOverride = params.forkContextMessagesOverride
      seen.role = params.currentRoleOverride?.agentType
      seen.promptIncludesText = params.prompt.includes('web transcript input')
      return { kind: 'success', finalText: 'ok', stopReason: 'end_turn' }
    })

    await triggerForkExtract({
      canonicalUser: 'alice',
      ownerRole: webRole,
      forkTranscriptPath,
      memoryDir: tempDir,
      config: dummyConfig,
    })

    // forkContextSlice should be empty (no parent prefix in this fork)
    assert.deepEqual(seen.contextOverride, [])
    // owning role is web (currentRole physical binding)
    assert.equal(seen.role, 'web')
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
  // messages came from the parent's cacheSafeParams forkContextMessages
  // (parent DM context the worker inherited) and the last 2 are the worker's
  // own user prompt + assistant turn. Extract analyzes only the fork-own
  // slice; the parent prefix is passed through as `forkContextMessagesOverride`
  // so the extract subagent keeps the worker's worldview.
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'lightclaw-extract-'))
  const webRole = getAgent('web')
  assert.ok(webRole)
  const parentContext = [
    createUserMessage('parent DM line one', null, 1),
    createUserMessage('parent DM line two', null, 2),
  ]
  const forkOwn = [
    createUserMessage('web fork prompt: query X', null, 10),
    createAssistantMessage({
      content: [{ type: 'text', text: 'web answer about X' }],
      stopReason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
      parentUuid: null,
      timestamp: 11,
    }),
  ]
  const allMessages = [...parentContext, ...forkOwn]
  const forkTranscriptPath = path.join(tempDir, 'parent', 'forks', 'web-slice.jsonl')
  const seen: {
    contextOverride?: unknown
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
      seen.contextOverride = params.forkContextMessagesOverride
      seen.promptHasParent = params.prompt.includes('parent DM line one')
      seen.promptHasOwn = params.prompt.includes('web fork prompt: query X')
      return { kind: 'success', finalText: 'ok', stopReason: 'end_turn' }
    })

    await triggerForkExtract({
      canonicalUser: 'alice',
      ownerRole: webRole,
      forkTranscriptPath,
      memoryDir: tempDir,
      config: dummyConfig,
    })

    // forkContextMessagesOverride carries parent prefix as the worker's
    // inherited worldview (extract subagent cache prefix)
    assert.deepEqual(seen.contextOverride, parentContext)
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
    await writeMemoryFile(path.join(tempDir, 'web'), memory('web-note.md'))

    const entries = await collectExistingMemoriesForRole(getMainRole(), tempDir)

    assert.deepEqual(entries.map(entry => entry.filename), [
      '_shared/shared-note.md',
      'root-note.md',
    ])
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('collectExistingMemoriesForRole gives web private plus shared, excluding root', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'lightclaw-extract-'))
  const webRole = getAgent('web')
  assert.ok(webRole)
  try {
    await writeMemoryFile(tempDir, memory('root-note.md'))
    await writeMemoryFile(path.join(tempDir, '_shared'), memory('same-name.md'))
    await writeMemoryFile(path.join(tempDir, 'web'), memory('same-name.md'))

    const entries = await collectExistingMemoriesForRole(webRole, tempDir)

    assert.deepEqual(entries.map(entry => entry.filename), [
      '_shared/same-name.md',
      'web/same-name.md',
    ])
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('drainPendingExtraction waits for multiple active role instances', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'lightclaw-extract-'))
  const webRole = getAgent('web')
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
      forkContextMessages: messages,
    })
    const webTask = executeExtraction({
      messages,
      lastExtractedAt: 0,
      memoryDir: tempDir,
      canonicalUser: 'alice',
      config,
      ownerRole: webRole,
      forkContextMessages: messages,
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
