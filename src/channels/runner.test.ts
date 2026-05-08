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
import { setLang } from '../i18n/index.js'
import type { Runtime } from '../runtime/types.js'

import {
  applyAttachmentMaterialization,
  ChannelRunner,
  type ChannelRunnerStrategy,
} from './runner.js'
import type {
  MaterializedAttachment,
  NormalizedChannelMessage,
  PendingAttachment,
} from './types.js'

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
    assert.equal(parseFastPathSlash('/user approve abc123'), null)
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

describe('applyAttachmentMaterialization', () => {
  // Phase 24 contract: feishu raw onMessage attaches `pendingAttachment`,
  // ChannelRunner materializes it after pairing + runtime acquire via the
  // strategy hook. This block exercises the hook dispatcher in isolation
  // (no session lock / runtime pool / LLM) so each branch of the failure
  // matrix is unit-covered.

  function makePending(): PendingAttachment {
    return {
      kind: 'feishu-media',
      messageId: 'om_test',
      mediaKey: { kind: 'image', key: 'img_test' },
      fileName: 'test.jpg',
    }
  }

  function makeMessage(opts?: { withPending?: boolean }): NormalizedChannelMessage {
    const message: NormalizedChannelMessage = {
      channel: 'feishu',
      eventId: 'evt-1',
      chatId: 'oc_chat',
      senderOpenId: 'ou_alice',
      messageId: 'om_test',
      text: 'hello',
    }
    if (opts?.withPending !== false) {
      message.pendingAttachment = makePending()
    }
    return message
  }

  function makeRuntime(): Runtime {
    return { workspaceRoot: '/workspace' } as unknown as Runtime
  }

  function captureStderr(): { lines: string[]; restore: () => void } {
    const lines: string[] = []
    const original = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: unknown) => {
      lines.push(typeof chunk === 'string' ? chunk : String(chunk))
      return true
    }) as typeof process.stderr.write
    return {
      lines,
      restore: () => {
        process.stderr.write = original
      },
    }
  }

  // Lock locale so assertions on the i18n download-failed notice are
  // deterministic regardless of which test ran before.
  beforeEach(() => {
    setLang('cn')
  })

  it('returns null and leaves text untouched when no pendingAttachment is set', async () => {
    const strategy = installFakeStrategy('feishu')
    let hookCalls = 0
    strategy.materializeAttachment = async () => {
      hookCalls += 1
      return null
    }
    const message = makeMessage({ withPending: false })
    const originalText = message.text

    const result = await applyAttachmentMaterialization(
      strategy,
      message,
      makeRuntime(),
      'feishu-alice',
    )

    assert.equal(result, null)
    assert.equal(hookCalls, 0, 'hook should not run when pendingAttachment is absent')
    assert.equal(message.text, originalText, 'text must not be mutated')
  })

  it('warns to stderr and appends download-failed notice when strategy lacks the hook', async () => {
    const strategy = installFakeStrategy('feishu')
    // Explicitly absent: makes the missing-hook branch unambiguous.
    delete strategy.materializeAttachment
    const message = makeMessage()
    const stderr = captureStderr()

    let result: MaterializedAttachment | null
    try {
      result = await applyAttachmentMaterialization(
        strategy,
        message,
        makeRuntime(),
        'feishu-alice',
      )
    } finally {
      stderr.restore()
    }

    assert.equal(result, null)
    assert.match(message.text, /\[媒体下载失败\]$/)
    assert.ok(
      stderr.lines.some(line =>
        line.includes('feishu got pendingAttachment without materializeAttachment hook'),
      ),
      `expected stderr warn, got: ${JSON.stringify(stderr.lines)}`,
    )
  })

  it('returns materialized attachment and leaves text untouched on hook success', async () => {
    const strategy = installFakeStrategy('feishu')
    const calls: Array<{
      pending: PendingAttachment
      runtime: Runtime
      message: NormalizedChannelMessage
    }> = []
    strategy.materializeAttachment = async input => {
      calls.push(input)
      return {
        path: '/workspace/.lightclaw/inbox/oc_chat/test.jpg',
        mimeType: 'image/jpeg',
      }
    }
    const message = makeMessage()
    const runtime = makeRuntime()
    const stderr = captureStderr()

    let result: MaterializedAttachment | null
    try {
      result = await applyAttachmentMaterialization(
        strategy,
        message,
        runtime,
        'feishu-alice',
      )
    } finally {
      stderr.restore()
    }

    assert.deepEqual(result, {
      path: '/workspace/.lightclaw/inbox/oc_chat/test.jpg',
      mimeType: 'image/jpeg',
    })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].pending.fileName, 'test.jpg')
    assert.equal(calls[0].runtime, runtime, 'runtime must be threaded through unchanged')
    assert.equal(calls[0].message, message, 'message must be passed by reference')
    assert.equal(message.text, 'hello', 'text must not be mutated on success')
    assert.ok(
      stderr.lines.some(line =>
        line.includes('attachment materialized') &&
        line.includes('session=feishu-alice') &&
        line.includes('/workspace/.lightclaw/inbox/oc_chat/test.jpg'),
      ),
      `expected materialized stderr line, got: ${JSON.stringify(stderr.lines)}`,
    )
  })

  it('returns null and appends download-failed notice when hook returns null', async () => {
    const strategy = installFakeStrategy('feishu')
    strategy.materializeAttachment = async () => null
    const message = makeMessage()
    const stderr = captureStderr()

    let result: MaterializedAttachment | null
    try {
      result = await applyAttachmentMaterialization(
        strategy,
        message,
        makeRuntime(),
        'feishu-alice',
      )
    } finally {
      stderr.restore()
    }

    assert.equal(result, null)
    assert.match(message.text, /\[媒体下载失败\]$/)
    // No "threw" warn — null return is a graceful failure path that the
    // hook itself already logged in stderr (e.g. SDK error envelope).
    assert.ok(
      !stderr.lines.some(line => line.includes('materializeAttachment threw')),
      'null return must not emit the throw-path warn',
    )
  })

  it('returns null, warns, and appends notice when hook throws', async () => {
    const strategy = installFakeStrategy('feishu')
    strategy.materializeAttachment = async () => {
      throw new Error('disk full')
    }
    const message = makeMessage()
    const stderr = captureStderr()

    let result: MaterializedAttachment | null
    try {
      result = await applyAttachmentMaterialization(
        strategy,
        message,
        makeRuntime(),
        'feishu-alice',
      )
    } finally {
      stderr.restore()
    }

    assert.equal(result, null)
    assert.match(message.text, /\[媒体下载失败\]$/)
    assert.ok(
      stderr.lines.some(line =>
        line.includes('materializeAttachment threw') && line.includes('disk full'),
      ),
      `expected throw-path warn, got: ${JSON.stringify(stderr.lines)}`,
    )
  })
})
