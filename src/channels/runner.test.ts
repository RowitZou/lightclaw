import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import {
  installFakeStrategy,
  makeFakeFeishuMessage,
} from '../__tests__/concurrency-helpers.js'
import { createUser, addLink } from '../identity/store.js'
import { setLightclawHomeOverride } from '../paths.js'

import { ChannelRunner } from './runner.js'

const ENV_KEYS = [
  'LIGHTCLAW_MODEL',
  'LIGHTCLAW_RUNTIME_BACKEND',
  'LIGHTCLAW_SESSIONS_DIR',
  'LIGHTCLAW_WORKSPACE_ROOT',
  'LIGHTCLAW_MEMORY_DIR',
] as const

const savedEnv: Partial<Record<typeof ENV_KEYS[number], string>> = {}
let tmpHome: string

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function writeConfig(): void {
  writeFileSync(
    path.join(tmpHome, 'config.json'),
    JSON.stringify({
      endpoints: {
        fake: { apiKey: 'sk-fake' },
      },
      models: {
        fake: {
          endpoint: 'fake',
          schema: 'anthropic',
          upstreamModel: 'claude-fake',
        },
      },
      defaultModel: 'fake',
      autoMemory: false,
      hooksEnabled: false,
      mcpEnabled: false,
      runtime: {
        backend: 'docker',
        docker: {
          image: 'lightclaw-test',
          autoPull: false,
        },
      },
    }),
  )
}

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-runner-test-'))
  setLightclawHomeOverride(tmpHome)
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  writeConfig()
})

afterEach(() => {
  setLightclawHomeOverride(undefined)
  rmSync(tmpHome, { recursive: true, force: true })
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = savedEnv[key]
    }
  }
})

describe('ChannelRunner multi-user concurrency', () => {
  it('does not block a second fake sender behind another sender typing delay', async () => {
    await createUser('alice')
    await addLink('alice', 'feishu:ou_alice')
    await createUser('bob')
    await addLink('bob', 'feishu:ou_bob')

    const strategy = installFakeStrategy('feishu')
    const noticeAt = new Map<string, number>()
    const baseStartTyping = strategy.startTyping
    const baseSendNotice = strategy.sendNotice
    strategy.startTyping = async message => {
      if (message.senderOpenId === 'ou_alice') {
        await delay(5_000)
      }
      return baseStartTyping?.(message)
    }
    strategy.sendNotice = async (message, kind, text, bodyFormat) => {
      noticeAt.set(message.senderOpenId, Date.now())
      await baseSendNotice(message, kind, text, bodyFormat)
    }

    const runner = new ChannelRunner(strategy)
    const alice = makeFakeFeishuMessage({
      sender: 'ou_alice',
      text: '/help',
      sessionId: 'alice',
    })
    const bob = makeFakeFeishuMessage({
      sender: 'ou_bob',
      text: '/help',
      sessionId: 'bob',
    })

    const startedAt = Date.now()
    await Promise.all([
      runner.handleMessage(alice),
      runner.handleMessage(bob),
    ])
    const elapsed = Date.now() - startedAt

    assert.ok(elapsed < 6_000, `expected elapsed < 6000ms, got ${elapsed}ms`)
    assert.ok(
      (noticeAt.get('ou_bob') ?? Infinity) - startedAt < 1_500,
      'bob notice should not wait for alice typing delay',
    )
    assert.ok(strategy.notices.some(item => item.messageId === bob.messageId))
    assert.ok(strategy.notices.some(item => item.messageId === alice.messageId))
  })
})

describe('ChannelRunner pre-lock fast path', () => {
  it('parseFastPathSlash classifies /stop, read whitelist, and write/non-slash correctly', async () => {
    const { parseFastPathSlash } = await import('./runner.js')
    // /stop short-circuit
    assert.equal(parseFastPathSlash('/stop'), 'stop')
    assert.equal(parseFastPathSlash('  /stop  '), 'stop')
    // Read whitelist
    assert.equal(parseFastPathSlash('/help'), 'read')
    assert.equal(parseFastPathSlash('/help anything trailing'), 'read')
    assert.equal(parseFastPathSlash('/cost'), 'read')
    assert.equal(parseFastPathSlash('/mode'), 'read')
    assert.equal(parseFastPathSlash('/model'), 'read')
    assert.equal(parseFastPathSlash('/rules'), 'read')
    assert.equal(parseFastPathSlash('/rules list'), 'read')
    assert.equal(parseFastPathSlash('/rules list ...filter'), 'read')
    assert.equal(parseFastPathSlash('/auth list'), 'read')
    assert.equal(parseFastPathSlash('/user'), 'read')
    assert.equal(parseFastPathSlash('/user list'), 'read')
    assert.equal(parseFastPathSlash('/user pending'), 'read')
    assert.equal(parseFastPathSlash('/user feedback --page 2'), 'read')
    // Write variants of sub-command slashes — must NOT fast-path so they
    // serialize behind any in-flight turn.
    assert.equal(parseFastPathSlash('/mode auto'), null)
    assert.equal(parseFastPathSlash('/model claude-x'), null)
    assert.equal(parseFastPathSlash('/rules allow Bash(curl:*)'), null)
    assert.equal(parseFastPathSlash('/rules deny Edit(/etc/**)'), null)
    assert.equal(parseFastPathSlash('/rules revoke 3'), null)
    assert.equal(parseFastPathSlash('/auth import codex'), null)
    assert.equal(parseFastPathSlash('/auth logout codex'), null)
    assert.equal(parseFastPathSlash('/user approve abc123 --as alice'), null)
    assert.equal(parseFastPathSlash('/user remove bob'), null)
    // /status fast-path: msgs from disk transcript, mode/model from
    // prefs, sessionId from main-canonical. In-flight token = 0 is
    // honest semantics for "before this turn started".
    assert.equal(parseFastPathSlash('/status'), 'read')
    // /sandbox status fast-path: runReadSlashFastPath acquires a runtime
    // from the per-canonical pool so workerSnapshot / isAvailable work.
    assert.equal(parseFastPathSlash('/sandbox'), 'read')
    assert.equal(parseFastPathSlash('/sandbox status'), 'read')
    // /sandbox writes (prefetch / reset) must still queue.
    assert.equal(parseFastPathSlash('/sandbox prefetch'), null)
    assert.equal(parseFastPathSlash('/sandbox reset'), null)
    // /feedback writes feedback.jsonl on a separate path from the
    // session transcript — no main-lock contention, no LLM call.
    assert.equal(parseFastPathSlash('/feedback something'), 'read')
    // /branch / /fresh have their own lock keys, not pre-lock.
    assert.equal(parseFastPathSlash('/branch hi'), null)
    assert.equal(parseFastPathSlash('/b hi'), null)
    assert.equal(parseFastPathSlash('/fresh hi'), null)
    // Non-slash falls through.
    assert.equal(parseFastPathSlash('hello'), null)
    assert.equal(parseFastPathSlash(''), null)
  })

  it('runs /stop without waiting for the main session lock to release', async () => {
    await createUser('alice')
    await addLink('alice', 'feishu:ou_alice')

    const { channelSessionLock } = await import('./session-lock.js')
    const strategy = installFakeStrategy('feishu')
    const runner = new ChannelRunner(strategy)

    // Hold the main session lock externally for 3 seconds — simulating an
    // in-flight long query that would otherwise queue /stop behind itself.
    let releaseHold: (() => void) | undefined
    const heldLock = channelSessionLock.runExclusive(
      'feishu-alice',
      () => new Promise<void>(resolve => {
        releaseHold = resolve
      }),
    )

    const stopMessage = makeFakeFeishuMessage({
      sender: 'ou_alice',
      text: '/stop',
      sessionId: 'feishu-alice',
    })
    const startedAt = Date.now()
    await runner.handleMessage(stopMessage)
    const elapsed = Date.now() - startedAt

    assert.ok(
      elapsed < 500,
      `/stop should fast-path past the held lock; got elapsed ${elapsed}ms`,
    )
    assert.ok(
      strategy.notices.some(item => item.messageId === stopMessage.messageId),
      '/stop should produce a notice even when the main lock is held',
    )

    releaseHold?.()
    await heldLock
  })

  it('runs /help via the read fast path while the main lock is held', async () => {
    await createUser('alice')
    await addLink('alice', 'feishu:ou_alice')

    const { channelSessionLock } = await import('./session-lock.js')
    const strategy = installFakeStrategy('feishu')
    const runner = new ChannelRunner(strategy)

    let releaseHold: (() => void) | undefined
    const heldLock = channelSessionLock.runExclusive(
      'feishu-alice',
      () => new Promise<void>(resolve => {
        releaseHold = resolve
      }),
    )

    const helpMessage = makeFakeFeishuMessage({
      sender: 'ou_alice',
      text: '/help',
      sessionId: 'feishu-alice',
    })
    const startedAt = Date.now()
    await runner.handleMessage(helpMessage)
    const elapsed = Date.now() - startedAt

    assert.ok(
      elapsed < 500,
      `/help should fast-path past the held lock; got elapsed ${elapsed}ms`,
    )
    assert.ok(
      strategy.notices.some(item => item.messageId === helpMessage.messageId),
      '/help should produce a notice even when the main lock is held',
    )

    releaseHold?.()
    await heldLock
  })

  it('runs /status via the read fast path while the main lock is held', async () => {
    await createUser('alice')
    await addLink('alice', 'feishu:ou_alice')

    const { channelSessionLock } = await import('./session-lock.js')
    const strategy = installFakeStrategy('feishu')
    const runner = new ChannelRunner(strategy)

    let releaseHold: (() => void) | undefined
    const heldLock = channelSessionLock.runExclusive(
      'feishu-alice',
      () => new Promise<void>(resolve => {
        releaseHold = resolve
      }),
    )

    const statusMessage = makeFakeFeishuMessage({
      sender: 'ou_alice',
      text: '/status',
      sessionId: 'feishu-alice',
    })
    const startedAt = Date.now()
    await runner.handleMessage(statusMessage)
    const elapsed = Date.now() - startedAt

    assert.ok(
      elapsed < 500,
      `/status should fast-path past the held lock; got elapsed ${elapsed}ms`,
    )
    const statusNotice = strategy.notices.find(
      item => item.messageId === statusMessage.messageId,
    )
    assert.ok(statusNotice, '/status should produce a notice even when the main lock is held')
    // The /status output mentions the user — confirms the fresh-ctx path
    // wired the currentUserId correctly even outside the main lock.
    assert.match(statusNotice!.text, /alice/)

    releaseHold?.()
    await heldLock
  })

  it('runs /feedback via the read fast path while the main lock is held', async () => {
    await createUser('alice')
    await addLink('alice', 'feishu:ou_alice')

    const { channelSessionLock } = await import('./session-lock.js')
    const strategy = installFakeStrategy('feishu')
    const runner = new ChannelRunner(strategy)

    let releaseHold: (() => void) | undefined
    const heldLock = channelSessionLock.runExclusive(
      'feishu-alice',
      () => new Promise<void>(resolve => {
        releaseHold = resolve
      }),
    )

    const feedbackMessage = makeFakeFeishuMessage({
      sender: 'ou_alice',
      text: '/feedback love this bot',
      sessionId: 'feishu-alice',
    })
    const startedAt = Date.now()
    await runner.handleMessage(feedbackMessage)
    const elapsed = Date.now() - startedAt

    assert.ok(
      elapsed < 500,
      `/feedback should fast-path past the held lock; got elapsed ${elapsed}ms`,
    )
    assert.ok(
      strategy.notices.some(item => item.messageId === feedbackMessage.messageId),
      '/feedback should produce a notice even when the main lock is held',
    )

    releaseHold?.()
    await heldLock
  })
})
