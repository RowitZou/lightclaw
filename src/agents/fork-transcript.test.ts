import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createAssistantMessage, createUserMessage } from '../messages.js'
import { loadTranscriptFile } from '../session/storage.js'
import {
  getForkTranscriptPath,
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
