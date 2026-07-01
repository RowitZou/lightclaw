import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import type { LightClawConfig } from '../config.js'
import { createUserMessage } from '../messages.js'
import { createSessionContext, runWithSessionContext } from '../session-context.js'
import { resetSessionMemoryCounters } from '../state.js'
import type { Message } from '../types.js'
import {
  SESSION_MEMORY_FILENAME,
  SM_BODY_MAX_CHARS,
  setRequestSessionMemoryUpdateForTest,
  updateSessionMemory,
  updateSessionMemoryForSession,
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

describe('updateSessionMemoryForSession force vs threshold (Feature A core)', () => {
  // The mechanism Feature A relies on: force=true bypasses the accumulation
  // thresholds so a below-threshold-but-dirty session (the idle case: a task
  // finished across short turns) still lands a fresh SM, while force=false stays
  // threshold-gated (the mid-turn kick path) and a clean session is a no-op even
  // under force. Asserts on the on-disk session-memory.md content, not a call
  // count.
  const forceSessionId = 'sm-force-test'
  const thresholdConfig = {
    memory: {
      extractor: { enabled: true },
      session: {
        enabled: true,
        idleRefresh: true,
        updateTokenThreshold: 20_000,
        updateToolCallThreshold: 5,
      },
    },
  } as unknown as LightClawConfig

  function forceCtx() {
    return createSessionContext({
      cwd: '/tmp/sm-force',
      model: 'test-model',
      sessionsDir,
      memoryDir: path.join(tmpRoot, 'memory'),
      sessionId: forceSessionId,
      permissionMode: 'bypassPermissions',
    })
  }

  it('force flushes a dirty below-threshold session; force=false skips it; a clean session is a no-op', async () => {
    setRequestSessionMemoryUpdateForTest(async () => 'IDLE-FLUSHED-BODY')
    // No accumulation → below both thresholds.
    resetSessionMemoryCounters(forceSessionId)
    const messages: Message[] = [createUserMessage('finished the clone task')]
    const smPath = path.join(sessionsDir, forceSessionId, SESSION_MEMORY_FILENAME)

    // force=false: below-threshold, nothing written (the mid-turn kick would
    // freeze here — exactly the production bug for short trailing turns).
    const belowThreshold = await runWithSessionContext(forceCtx(), () =>
      updateSessionMemoryForSession({
        sessionId: forceSessionId,
        sessionsDir,
        messages,
        config: thresholdConfig,
        force: false,
      }),
    )
    assert.deepEqual(belowThreshold, { updated: false, reason: 'below-threshold' })
    await assert.rejects(() => readFile(smPath, 'utf8'), { code: 'ENOENT' })

    // force=true: dirty session flushes despite being below-threshold.
    const forced = await runWithSessionContext(forceCtx(), () =>
      updateSessionMemoryForSession({
        sessionId: forceSessionId,
        sessionsDir,
        messages,
        config: thresholdConfig,
        force: true,
      }),
    )
    assert.equal(forced.updated, true)
    const written = await readFile(smPath, 'utf8')
    assert.match(written, /IDLE-FLUSHED-BODY/)

    // Watermark advanced → the same messages are now clean; force cannot conjure
    // work out of an unchanged session.
    const clean = await runWithSessionContext(forceCtx(), () =>
      updateSessionMemoryForSession({
        sessionId: forceSessionId,
        sessionsDir,
        messages,
        config: thresholdConfig,
        force: true,
      }),
    )
    assert.deepEqual(clean, { updated: false, reason: 'clean' })
  })
})
