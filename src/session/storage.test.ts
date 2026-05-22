import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

import { appendMessage, appendMessages, loadTranscript } from './storage.js'
import { createUserMessage } from '../messages.js'

let tmpSessionsDir: string
let savedSessionsDir: string | undefined

beforeEach(() => {
  tmpSessionsDir = mkdtempSync(path.join(tmpdir(), 'lightclaw-storage-test-'))
  savedSessionsDir = process.env.LIGHTCLAW_SESSIONS_DIR
  process.env.LIGHTCLAW_SESSIONS_DIR = tmpSessionsDir
})

afterEach(() => {
  if (savedSessionsDir === undefined) {
    delete process.env.LIGHTCLAW_SESSIONS_DIR
  } else {
    process.env.LIGHTCLAW_SESSIONS_DIR = savedSessionsDir
  }
  rmSync(tmpSessionsDir, { recursive: true, force: true })
})

describe('appendMessages (atomic batch transcript append)', () => {
  it('writes a batch as JSONL that loadTranscript reads back in order', async () => {
    const sid = 'feishu:dm:batch'
    const batch = [
      createUserMessage('m0', null),
      createUserMessage('m1', null),
      createUserMessage('m2', null),
    ]
    await appendMessages(sid, batch)
    assert.deepEqual(await loadTranscript(sid), batch)
  })

  it('is a no-op on an empty batch — creates no session directory', async () => {
    const sid = 'feishu:dm:empty'
    await appendMessages(sid, [])
    assert.equal(existsSync(path.join(tmpSessionsDir, sid)), false)
    assert.deepEqual(await loadTranscript(sid), [])
  })

  it('interleaves with appendMessage, preserving global order', async () => {
    const sid = 'feishu:dm:mixed'
    const a = createUserMessage('a', null)
    const b = createUserMessage('b', null)
    const c = createUserMessage('c', null)
    const d = createUserMessage('d', null)
    await appendMessage(sid, a)
    await appendMessages(sid, [b, c])
    await appendMessage(sid, d)
    assert.deepEqual(await loadTranscript(sid), [a, b, c, d])
  })

  it('a batch append produces the same transcript as message-by-message appends', async () => {
    const batch = [
      createUserMessage('x', null),
      createUserMessage('y', null),
      createUserMessage('z', null),
    ]
    await appendMessages('feishu:dm:one-write', batch)
    for (const message of batch) {
      await appendMessage('feishu:dm:n-writes', message)
    }
    assert.deepEqual(
      await loadTranscript('feishu:dm:one-write'),
      await loadTranscript('feishu:dm:n-writes'),
    )
  })
})
