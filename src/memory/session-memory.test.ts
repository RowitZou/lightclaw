import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import type { LightClawConfig } from '../config.js'
import { createUserMessage } from '../messages.js'
import type { Message } from '../types.js'
import {
  SESSION_MEMORY_FILENAME,
  SM_BODY_MAX_CHARS,
  setRequestSessionMemoryUpdateForTest,
  updateSessionMemory,
} from './session-memory.js'

let tmpRoot = ''
let sessionsDir = ''
const sessionId = 'sm-cap-test'
const stubConfig = {} as LightClawConfig
const newMessages: Message[] = [createUserMessage('hello')]

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), 'lightclaw-sm-'))
  sessionsDir = path.join(tmpRoot, 'sessions')
  await mkdir(path.join(sessionsDir, sessionId), { recursive: true })
})

afterEach(async () => {
  setRequestSessionMemoryUpdateForTest(undefined)
  await rm(tmpRoot, { recursive: true, force: true })
})

describe('updateSessionMemory length cap', () => {
  it('writes the file when the first draft fits the cap', async () => {
    const body = 'small body within cap'
    setRequestSessionMemoryUpdateForTest(async () => body)

    const result = await updateSessionMemory({ sessionId, sessionsDir, newMessages, config: stubConfig })

    assert.deepEqual(result, { updated: true })
    const written = await readFile(path.join(sessionsDir, sessionId, SESSION_MEMORY_FILENAME), 'utf8')
    assert.equal(written.trimEnd(), body)
  })

  it('retries once with a length guidance when the first draft overshoots', async () => {
    const oversized = 'x'.repeat(SM_BODY_MAX_CHARS + 100)
    const trimmed = 'y'.repeat(SM_BODY_MAX_CHARS - 100)
    const calls: string[] = []
    let drafts = [oversized, trimmed]
    setRequestSessionMemoryUpdateForTest(async (prompt) => {
      calls.push(prompt)
      return drafts.shift() ?? ''
    })

    const result = await updateSessionMemory({ sessionId, sessionsDir, newMessages, config: stubConfig })

    assert.deepEqual(result, { updated: true })
    assert.equal(calls.length, 2)
    assert.match(calls[1]!, /## Length constraint/)
    assert.match(calls[1]!, new RegExp(`hard cap is ${SM_BODY_MAX_CHARS}`))
    const written = await readFile(path.join(sessionsDir, sessionId, SESSION_MEMORY_FILENAME), 'utf8')
    assert.equal(written.trimEnd(), trimmed)
  })

  it('keeps the previous SM and reports not-updated when retry still overshoots', async () => {
    const oversized = 'x'.repeat(SM_BODY_MAX_CHARS + 100)
    let drafts = [oversized, oversized]
    setRequestSessionMemoryUpdateForTest(async () => drafts.shift() ?? '')

    const result = await updateSessionMemory({ sessionId, sessionsDir, newMessages, config: stubConfig })

    assert.deepEqual(result, { updated: false })
    await assert.rejects(
      () => readFile(path.join(sessionsDir, sessionId, SESSION_MEMORY_FILENAME), 'utf8'),
      { code: 'ENOENT' },
    )
  })
})
