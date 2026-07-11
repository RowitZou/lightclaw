import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, afterEach, before, describe, it } from 'node:test'
import { z } from 'zod'

import { query, setStreamChatForTest } from './query.js'
import { setCompactConversationForTest } from './agents/hooks/auto-compact.js'
import {
  _resetExtractionStateForTest,
  _setRunSubagentForTest,
} from './memory/extract.js'
import { createSessionContext, runWithSessionContext } from './session-context.js'
import type { SessionContext } from './session-context.js'
import { installTestConfigHome } from './test-support/config-fixture.js'
import { getConfig } from './config.js'
import { awaitBackgroundTasks, getLastExtractedAt } from './state.js'
import { buildTool } from './tool.js'
import { createUserMessage } from './messages.js'
import type { Role } from './agents/types.js'
import type { Runtime } from './runtime/types.js'
import type { StreamEvent } from './types.js'

// Review 2026-07-10 §1.8: the pre-compact memory flush used to await an 8s
// race against the extraction subagent — a race real extractions structurally
// never won (the extractor's first token alone has p50 ~6.4s on the system
// lane), so every large-session compaction paid the full timeout as dead
// latency and then DROPPED the raced promise, losing the watermark advance
// (`lastExtractedAt` stayed stale → the next trigger re-analyzed the same
// window). The flush is now fire-and-forget with a continuation that persists
// the watermark when extraction eventually lands. These tests pin both halves:
// compaction proceeds while extraction is still pending, and the late result
// still advances + persists the watermark.

const COMPACT_ROLE: Role = {
  agentType: 'main',
  kind: 'orchestrator',
  whenToUse: 'test',
  systemPrompt: 'test',
  tools: ['*'],
  hooks: ['auto-compact'],
}

const pingTool = buildTool({
  name: 'Ping',
  description: 'A trivial tool that always succeeds.',
  domain: 'host',
  riskLevel: 'safe',
  inputSchema: z.object({}),
  call() {
    return Promise.resolve({ output: 'pong' })
  },
})

async function* endTurn(): AsyncGenerator<StreamEvent> {
  yield {
    type: 'stop',
    stopReason: 'end_turn',
    usage: { input_tokens: 8, output_tokens: 4 },
    content: [{ type: 'text', text: 'all done' }],
  }
}

function fakeStreamChat(): void {
  const impl = (): AsyncGenerator<StreamEvent> => endTurn()
  setStreamChatForTest(impl as unknown as Parameters<typeof setStreamChatForTest>[0])
}

/** Compaction stub that never removes anything — these tests only exercise
 *  the pre-compact flush that runs before it. */
function installNoopCompaction(): void {
  setCompactConversationForTest(async params => ({
    messages: [...params.messages],
    summaryTokens: 0,
    removedCount: 0,
    usage: {},
  }))
}

/** A config that trips the compaction threshold on every turn with the
 *  pre-compact flush left ON. */
function flushForcingConfig(preFlushEnabled: boolean) {
  const base = getConfig()
  return {
    ...base,
    contextWindow: 1,
    compact: {
      ...base.compact,
      auto: true,
      keepRecent: 2,
      preFlush: { enabled: preFlushEnabled },
    },
    memory: {
      ...base.memory,
      extractor: { ...base.memory.extractor, enabled: true },
    },
  }
}

describe('pre-compact flush is fire-and-forget (review 07-10 §1.8)', () => {
  let restoreConfigHome: () => void
  let sessionsDir: string
  let memoryDir: string
  before(async () => {
    restoreConfigHome = installTestConfigHome()
    sessionsDir = await mkdtemp(path.join(os.tmpdir(), 'lightclaw-preflush-sessions-'))
    memoryDir = await mkdtemp(path.join(os.tmpdir(), 'lightclaw-preflush-memory-'))
  })
  after(async () => {
    restoreConfigHome()
    await rm(sessionsDir, { recursive: true, force: true })
    await rm(memoryDir, { recursive: true, force: true })
  })
  afterEach(() => {
    setStreamChatForTest(null)
    setCompactConversationForTest(null)
    _setRunSubagentForTest()
    _resetExtractionStateForTest()
  })

  function makeCtx(sessionId: string): SessionContext {
    return createSessionContext({
      cwd: '/tmp',
      model: 'test-model',
      sessionsDir,
      memoryDir,
      sessionId,
      channel: 'feishu',
      permissionMode: 'bypassPermissions',
      runtime: {} as unknown as Runtime,
    })
  }

  function runQuery(ctx: SessionContext, preFlushEnabled: boolean) {
    return runWithSessionContext(ctx, () =>
      query({
        role: COMPACT_ROLE,
        config: flushForcingConfig(preFlushEnabled),
        invocation: { systemPromptOverride: 'test system prompt' },
        messages: [createUserMessage('hello', null)],
        tools: [pingTool],
      }),
    )
  }

  it('does not block the turn on extraction, and the late result persists the watermark', async () => {
    installNoopCompaction()
    fakeStreamChat()

    // Extraction subagent stub: every call blocks on one shared gate the
    // test releases only AFTER the query has completed — a deterministic
    // stand-in for "the extractor is slower than the whole turn". The
    // `started` promise is the deterministic launch signal (the pipeline
    // reaches the subagent a few async ticks after the kick, so asserting a
    // call count right at query end would race).
    let releaseExtraction!: () => void
    const extractionGate = new Promise<void>(resolve => {
      releaseExtraction = resolve
    })
    let signalStarted!: () => void
    const started = new Promise<void>(resolve => {
      signalStarted = resolve
    })
    _setRunSubagentForTest(async () => {
      signalStarted()
      await extractionGate
      return { kind: 'success', finalText: 'ok', stopReason: 'end_turn' }
    })

    const sessionId = 'feishu:dm:preflush-async-test'
    const ctx = makeCtx(sessionId)
    await runQuery(ctx, true)

    // The query is already done; the extraction gate is still closed. Wait
    // for the launch signal (hangs into the test timeout if the flush never
    // launched), then pin that nothing in the turn consumed a result.
    await started
    const watermarkAtTurnEnd = await runWithSessionContext(ctx, async () => getLastExtractedAt())
    assert.equal(watermarkAtTurnEnd, 0, 'watermark untouched while extraction is in flight')

    // Release the extractor. The flush continuation must consume the result:
    // advance the in-memory watermark AND persist it to session meta. This is
    // the half the old 8s-race shape dropped on timeout.
    releaseExtraction()
    await runWithSessionContext(ctx, () => awaitBackgroundTasks())

    const watermark = await runWithSessionContext(ctx, async () => getLastExtractedAt())
    assert.ok(watermark > 0, 'late extraction result advanced the in-memory watermark')

    const metaRaw = await readFile(
      path.join(sessionsDir, sessionId, 'meta.json'),
      'utf8',
    )
    const meta = JSON.parse(metaRaw) as { lastExtractedAt?: number }
    assert.equal(
      meta.lastExtractedAt,
      watermark,
      'late extraction result persisted the watermark to session meta',
    )
  })

  it('does not launch an extraction when preFlush is disabled', async () => {
    installNoopCompaction()
    fakeStreamChat()

    let subagentCalls = 0
    _setRunSubagentForTest(async () => {
      subagentCalls += 1
      return { kind: 'success', finalText: 'ok', stopReason: 'end_turn' }
    })

    const ctx = makeCtx('feishu:dm:preflush-disabled-test')
    await runQuery(ctx, false)
    await runWithSessionContext(ctx, () => awaitBackgroundTasks())

    assert.equal(subagentCalls, 0)
  })

  it('leaves the watermark alone when the extraction subagent fails', async () => {
    installNoopCompaction()
    fakeStreamChat()

    _setRunSubagentForTest(async () => ({
      kind: 'failure',
      envelope: {
        status: 'failed',
        reason: 'aborted',
        message: 'test-injected extraction failure',
      },
    }) as never)

    const sessionId = 'feishu:dm:preflush-failure-test'
    const ctx = makeCtx(sessionId)
    await runQuery(ctx, true)
    await runWithSessionContext(ctx, () => awaitBackgroundTasks())

    const watermark = await runWithSessionContext(ctx, async () => getLastExtractedAt())
    assert.equal(watermark, 0, 'failed extraction must not advance the watermark')
    await assert.rejects(
      readFile(path.join(sessionsDir, sessionId, 'meta.json'), 'utf8'),
      /ENOENT/,
      'failed extraction must not create/update session meta',
    )
  })
})
