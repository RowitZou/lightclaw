import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createAssistantMessage, createUserMessage } from '../messages.js'
import { loadTranscriptFile } from '../session/storage.js'
import {
  getForkTranscriptPath,
  parseForkTranscriptFile,
  persistForkTranscript,
} from './fork-transcript.js'

test('fork transcript path lives under parent session forks dir', () => {
  const filePath = getForkTranscriptPath({
    sessionsDir: '/tmp/lightclaw-sessions',
    parentSessionId: 'feishu:dm:chat',
    roleAgentType: 'web',
    forkId: 'abc12345',
  })

  assert.equal(
    filePath,
    path.join('/tmp/lightclaw-sessions', 'feishu:dm:chat', 'forks', 'web-abc12345.jsonl'),
  )
})

test('persistForkTranscript writes JSONL that the transcript parser can round-trip', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'lightclaw-fork-transcript-'))
  try {
    const filePath = getForkTranscriptPath({
      sessionsDir: tempDir,
      parentSessionId: 'parent-session',
      roleAgentType: 'web',
      forkId: 'fork1',
    })
    const messages = [
      createUserMessage('research this', null, 1),
      createAssistantMessage({
        content: [{ type: 'text', text: 'done' }],
        stopReason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
        parentUuid: null,
        timestamp: 2,
      }),
    ]

    await persistForkTranscript(filePath, messages)

    const parsed = await loadTranscriptFile(filePath)
    assert.deepEqual(parsed, messages)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('persistForkTranscript writes a meta marker that parseForkTranscriptFile round-trips', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'lightclaw-fork-transcript-'))
  try {
    const filePath = getForkTranscriptPath({
      sessionsDir: tempDir,
      parentSessionId: 'parent',
      roleAgentType: 'web',
      forkId: 'marker',
    })
    const parentPrefix = [
      createUserMessage('inherited parent line', null, 1),
    ]
    const forkOwn = [
      createUserMessage('fork prompt', null, 10),
      createAssistantMessage({
        content: [{ type: 'text', text: 'fork answer' }],
        stopReason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
        parentUuid: null,
        timestamp: 11,
      }),
    ]
    const all = [...parentPrefix, ...forkOwn]

    await persistForkTranscript(filePath, all, parentPrefix.length)
    const parsed = await parseForkTranscriptFile(filePath)
    assert.equal(parsed.forkContextEndIndex, parentPrefix.length)
    assert.deepEqual(parsed.messages, all)

    // loadTranscriptFile (the legacy main-transcript reader) skips the marker
    // line as a non-Message dict; it still returns all Message lines so
    // existing test from above (round-trip via loadTranscriptFile) keeps
    // passing.
    const legacyLoad = await loadTranscriptFile(filePath)
    assert.deepEqual(legacyLoad, all)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('parseForkTranscriptFile defaults forkContextEndIndex to 0 when marker is missing', async () => {
  // Defensive: a hand-written or corrupt JSONL without a meta header is
  // treated as fully fork-own (slicing produces empty parent prefix,
  // everything is fork-own). This is also the fallback for any pre-Option-C
  // fork transcripts that might exist on disk.
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'lightclaw-fork-transcript-'))
  try {
    const filePath = getForkTranscriptPath({
      sessionsDir: tempDir,
      parentSessionId: 'parent',
      roleAgentType: 'web',
      forkId: 'no-marker',
    })
    const messages = [createUserMessage('lone fork message', null, 1)]
    // Write directly without the marker line
    const { writeFile, mkdir } = await import('node:fs/promises')
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(
      filePath,
      messages.map(message => JSON.stringify(message)).join('\n') + '\n',
      'utf8',
    )

    const parsed = await parseForkTranscriptFile(filePath)
    assert.equal(parsed.forkContextEndIndex, 0)
    assert.deepEqual(parsed.messages, messages)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('concurrent fork transcript writes to different role/fork files do not collide', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'lightclaw-fork-transcript-'))
  try {
    const webPath = getForkTranscriptPath({
      sessionsDir: tempDir,
      parentSessionId: 'parent-session',
      roleAgentType: 'web',
      forkId: 'same',
    })
    const explorePath = getForkTranscriptPath({
      sessionsDir: tempDir,
      parentSessionId: 'parent-session',
      roleAgentType: 'explore',
      forkId: 'same',
    })

    await Promise.all([
      persistForkTranscript(webPath, [createUserMessage('web', null, 1)]),
      persistForkTranscript(explorePath, [createUserMessage('explore', null, 2)]),
    ])

    assert.equal((await loadTranscriptFile(webPath))[0]?.message.content, 'web')
    assert.equal((await loadTranscriptFile(explorePath))[0]?.message.content, 'explore')
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})
