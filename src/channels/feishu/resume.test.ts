import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

import { setLightclawHomeOverride } from '../../paths.js'
import { setAdmin } from '../../identity/store.js'
import { createAssistantMessage, createUserMessage } from '../../messages.js'
import { loadMeta } from '../../session/storage.js'
import { clearChannelRunner, registerChannelRunner } from './runner-registry.js'
import type { ChannelRunner } from '../runner.js'
import type { NormalizedChannelMessage } from '../types.js'
import type { Message } from '../../types.js'
import { resumePendingTurns } from './resume.js'

// PR-B (crash resume): on daemon restart, sessions whose transcript still
// carries a pendingTurn marker (a hard crash interrupted the turn) are
// re-entered through handleMessage with a `resumeExisting` synthetic message.

const GROUP_SESSION = 'feishu:group:oc_grp:ou_alice'

describe('resumePendingTurns', () => {
  let tmpHome: string
  let captured: NormalizedChannelMessage[] = []
  let registeredRunner: ChannelRunner | null = null

  beforeEach(async () => {
    tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-resume-test-'))
    setLightclawHomeOverride(tmpHome)
    writeFileSync(path.join(tmpHome, 'config.json'), JSON.stringify({
      endpoints: { a: { apiKey: 'sk-fake' } },
      models: { m: { endpoint: 'a', schema: 'anthropic', upstreamModel: 'claude-fake' } },
      defaultModel: 'm',
      runtime: { backend: 'local' },
    }))
    await setAdmin('alice')

    captured = []
    registeredRunner = {
      handleMessage: async (message: NormalizedChannelMessage) => {
        captured.push(message)
      },
    } as unknown as ChannelRunner
    registerChannelRunner(registeredRunner)
  })

  afterEach(() => {
    if (registeredRunner) {
      clearChannelRunner(registeredRunner)
      registeredRunner = null
    }
    setLightclawHomeOverride(undefined)
    rmSync(tmpHome, { recursive: true, force: true })
  })

  function writeSession(
    sessionId: string,
    input: { pendingTurn: { startedAt: number; resumeAttempts: number } | undefined; transcript: Message[] },
  ): void {
    const dir = path.join(tmpHome, 'sessions', sessionId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
      sessionId,
      model: 'm',
      cwd: '/tmp',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      messageCount: input.transcript.length,
      compactionCount: 0,
      userId: 'alice',
      ...(input.pendingTurn ? { pendingTurn: input.pendingTurn } : {}),
    }))
    writeFileSync(
      path.join(dir, 'transcript.jsonl'),
      `${input.transcript.map(m => JSON.stringify(m)).join('\n')}\n`,
    )
  }

  const midTurnTranscript = (): Message[] => [
    createUserMessage('do something', null),
    createAssistantMessage({
      content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }],
      stopReason: 'tool_use',
      usage: {},
      parentUuid: null,
    }),
    createUserMessage([{ type: 'tool_result', tool_use_id: 't1', content: 'done' }], null),
  ]

  it('resumes a session whose transcript ends mid-turn', async () => {
    writeSession(GROUP_SESSION, {
      pendingTurn: { startedAt: Date.now(), resumeAttempts: 0 },
      transcript: midTurnTranscript(),
    })

    await resumePendingTurns()

    assert.equal(captured.length, 1)
    assert.equal(captured[0].resumeExisting, true)
    assert.equal(captured[0].synthetic, true)
    assert.equal(captured[0].chatId, 'oc_grp')
    assert.equal(captured[0].senderOpenId, 'ou_alice')
    // The resume attempt counter was bumped before the synthetic turn.
    const meta = await loadMeta(GROUP_SESSION)
    assert.equal(meta?.pendingTurn?.resumeAttempts, 1)
  })

  it('skips and clears a marker that is too old', async () => {
    writeSession(GROUP_SESSION, {
      pendingTurn: { startedAt: Date.now() - 3 * 60 * 60 * 1000, resumeAttempts: 0 },
      transcript: midTurnTranscript(),
    })

    await resumePendingTurns()

    assert.equal(captured.length, 0)
    const meta = await loadMeta(GROUP_SESSION)
    assert.equal(meta?.pendingTurn, undefined)
  })

  it('gives up and clears the marker after the attempt cap', async () => {
    writeSession(GROUP_SESSION, {
      pendingTurn: { startedAt: Date.now(), resumeAttempts: 2 },
      transcript: midTurnTranscript(),
    })

    await resumePendingTurns()

    assert.equal(captured.length, 0)
    const meta = await loadMeta(GROUP_SESSION)
    assert.equal(meta?.pendingTurn, undefined)
  })

  it('does not resume a transcript that ends with a completed turn', async () => {
    writeSession(GROUP_SESSION, {
      pendingTurn: { startedAt: Date.now(), resumeAttempts: 0 },
      transcript: [
        createUserMessage('do something', null),
        createAssistantMessage({
          content: [{ type: 'text', text: 'all done' }],
          stopReason: 'end_turn',
          usage: {},
          parentUuid: null,
        }),
      ],
    })

    await resumePendingTurns()

    assert.equal(captured.length, 0)
    const meta = await loadMeta(GROUP_SESSION)
    assert.equal(meta?.pendingTurn, undefined)
  })

  it('ignores sessions with no pendingTurn marker', async () => {
    writeSession(GROUP_SESSION, {
      pendingTurn: undefined,
      transcript: midTurnTranscript(),
    })

    await resumePendingTurns()

    assert.equal(captured.length, 0)
  })
})
