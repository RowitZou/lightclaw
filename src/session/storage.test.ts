import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

import { appendMessage, appendMessages, loadTranscript } from './storage.js'
import { createUserMessage } from '../messages.js'
import { setLightclawHomeOverride } from '../paths.js'
import {
  createEmptySessionContext,
  runWithSessionContext,
} from '../session-context.js'

// §十: sessions derive from <home>; isolate via the home override (the old
// LIGHTCLAW_SESSIONS_DIR per-subdir env was removed).
let tmpHome: string

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-storage-test-'))
  setLightclawHomeOverride(tmpHome)
})

afterEach(() => {
  setLightclawHomeOverride(undefined)
  rmSync(tmpHome, { recursive: true, force: true })
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
    assert.equal(existsSync(path.join(tmpHome, 'sessions', sid)), false)
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

describe('getSessionDir ambient-context mismatch guard', () => {
  // Production shape (2026-07-03): AsyncLocalStorage leaks the startup
  // bootstrap SessionContext into channel socket handlers, so a bare
  // loadTranscript(sessionId) there resolved another user's session into the
  // bootstrap identity's sessions dir and read empty — every non-bootstrap
  // user's turn reached the model with zero history while writes (made inside
  // the correctly-hydrated per-turn scope) kept accumulating on disk.
  it('reads a session living under a user dir even when the ambient context points at another identity', async () => {
    const sid = 'feishu:dm:oc_alice_chat'
    const aliceSessions = path.join(tmpHome, 'users', 'alice', 'sessions')
    const bootstrapSessions = path.join(tmpHome, 'users', 'admin', 'sessions')
    const batch = [createUserMessage('hello', null)]
    await runWithSessionContext(
      createEmptySessionContext({ sessionsDir: aliceSessions }),
      () => appendMessages(sid, batch),
    )
    const loaded = await runWithSessionContext(
      createEmptySessionContext({ sessionsDir: bootstrapSessions }),
      () => loadTranscript(sid),
    )
    assert.deepEqual(loaded, batch)
  })

  it('still creates a genuinely new session under the ambient context dir', async () => {
    const sid = 'feishu:dm:brand_new'
    const bobSessions = path.join(tmpHome, 'users', 'bob', 'sessions')
    await runWithSessionContext(
      createEmptySessionContext({ sessionsDir: bobSessions }),
      () => appendMessages(sid, [createUserMessage('hi', null)]),
    )
    assert.ok(existsSync(path.join(bobSessions, sid, 'transcript.jsonl')))
  })
})
