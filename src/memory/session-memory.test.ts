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

describe('concurrent refresh triggers dedup on the same work', () => {
  // The production shape: query.ts fire-and-forgets the end-turn flush, then the
  // runner immediately force-fires the Feature A idle refresh — the second
  // trigger arrives while the first LLM rewrite (40-60s in prod) is still in
  // flight. The watermark read/filter must happen inside the per-session
  // critical section: the later trigger has to observe the earlier write's
  // watermark advance and return clean, instead of filtering the SAME message
  // batch against the stale watermark and queuing a second full LLM rewrite of
  // work that is already summarized.
  const raceSessionId = 'sm-race-test'
  const raceConfig = {
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

  function raceCtx() {
    return createSessionContext({
      cwd: '/tmp/sm-race',
      model: 'test-model',
      sessionsDir,
      memoryDir: path.join(tmpRoot, 'memory'),
      sessionId: raceSessionId,
      permissionMode: 'bypassPermissions',
    })
  }

  it('a force refresh arriving during an in-flight write returns clean with no second LLM call', async () => {
    await mkdir(path.join(sessionsDir, raceSessionId), { recursive: true })
    let llmCalls = 0
    let releaseFirst!: (body: string) => void
    const firstCallGate = new Promise<string>(resolve => {
      releaseFirst = resolve
    })
    let signalFirstStarted!: () => void
    const firstStarted = new Promise<void>(resolve => {
      signalFirstStarted = resolve
    })
    setRequestSessionMemoryUpdateForTest(async () => {
      llmCalls += 1
      if (llmCalls === 1) {
        signalFirstStarted()
        return firstCallGate
      }
      return 'SECOND-DUPLICATE-BODY'
    })
    const messages: Message[] = [createUserMessage('heavy turn just ended')]
    resetSessionMemoryCounters(raceSessionId)

    // Trigger 1 (the end-turn flush, here as force to skip counter priming) —
    // its LLM rewrite blocks on the gate, holding the write in flight.
    const flush = runWithSessionContext(raceCtx(), () =>
      updateSessionMemoryForSession({
        sessionId: raceSessionId,
        sessionsDir,
        messages,
        config: raceConfig,
        force: true,
      }),
    )
    await firstStarted

    // Trigger 2 (the idle refresh) fires while trigger 1's write is in flight.
    const idleRefresh = runWithSessionContext(raceCtx(), () =>
      updateSessionMemoryForSession({
        sessionId: raceSessionId,
        sessionsDir,
        messages,
        config: raceConfig,
        force: true,
      }),
    )
    releaseFirst('FIRST-WRITE-BODY')

    const [flushResult, idleResult] = await Promise.all([flush, idleRefresh])
    assert.deepEqual(flushResult, { updated: true })
    // Pre-fix this was { updated: true } with llmCalls === 2: the idle refresh
    // read the watermark before the flush advanced it, filtered the same batch,
    // and queued a duplicate rewrite behind the per-session lock.
    assert.deepEqual(idleResult, { updated: false, reason: 'clean' })
    assert.equal(llmCalls, 1)
    const written = await readFile(
      path.join(sessionsDir, raceSessionId, SESSION_MEMORY_FILENAME),
      'utf8',
    )
    assert.match(written, /FIRST-WRITE-BODY/)
  })
})

describe('updateSessionMemoryForSession failure logging carries the sessionId', () => {
  // The rewrite runs fire-and-forget off-turn, so when several sessions' SM
  // updates interleave in the daemon log this error line is the only way to
  // attribute a stalled digest (2026-07-10 review §1.4: three `[session-memory]`
  // transient-error lines in prod, none attributable to a session).
  const sidLogSessionId = 'sm-sid-log-test'
  const sidLogConfig = {
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

  it('logs the sessionId when the LLM rewrite throws', async () => {
    setRequestSessionMemoryUpdateForTest(async () => {
      throw new Error('Our servers are currently overloaded. Please try again later.')
    })
    resetSessionMemoryCounters(sidLogSessionId)
    const messages: Message[] = [createUserMessage('some new work')]
    const logged: string[] = []
    const originalError = console.error
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(' '))
    }
    try {
      const ctx = createSessionContext({
        cwd: '/tmp/sm-sid-log',
        model: 'test-model',
        sessionsDir,
        memoryDir: path.join(tmpRoot, 'memory'),
        sessionId: sidLogSessionId,
        permissionMode: 'bypassPermissions',
      })
      const result = await runWithSessionContext(ctx, () =>
        updateSessionMemoryForSession({
          sessionId: sidLogSessionId,
          sessionsDir,
          messages,
          config: sidLogConfig,
          force: true,
        }),
      )
      assert.deepEqual(result, { updated: false })
    } finally {
      console.error = originalError
    }
    const errorLine = logged.find(line => line.includes('[session-memory]'))
    assert.ok(errorLine, 'expected a [session-memory] error line')
    assert.ok(
      errorLine.includes(sidLogSessionId),
      `error line must carry the sessionId for attribution, got: ${errorLine}`,
    )
    assert.match(errorLine, /overloaded/)
  })
})
