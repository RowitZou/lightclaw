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
  formatChannelUserText,
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

describe('ChannelRunner slash detection', () => {
  it('isLikelySlashCommand recognizes any text starting with / after trim', async () => {
    const { isLikelySlashCommand } = await import('./runner.js')
    // Recognized slashes (incl. write variants and unknown — we route by
    // shape, not by allowlist; dispatchChannelSlash will produce a usage
    // notice for unknown slashes, which is the right UX).
    assert.equal(isLikelySlashCommand('/help'), true)
    assert.equal(isLikelySlashCommand('/mode auto'), true)
    assert.equal(isLikelySlashCommand('/rules allow Bash(curl:*)'), true)
    assert.equal(isLikelySlashCommand('/auth import codex'), true)
    assert.equal(isLikelySlashCommand('/user approve abc'), true)
    assert.equal(isLikelySlashCommand('/sandbox prefetch'), true)
    assert.equal(isLikelySlashCommand('/whatever-unknown'), true)
    assert.equal(isLikelySlashCommand('  /stop  '), true)
    assert.equal(isLikelySlashCommand('\t/help'), true)
    // Non-slashes — including text that contains a slash later but does not
    // start with one. This is the in-flight interjection path: bare chat
    // ("好的"/"等下") must still queue as an interjection.
    assert.equal(isLikelySlashCommand('hello'), false)
    assert.equal(isLikelySlashCommand(''), false)
    assert.equal(isLikelySlashCommand('please run /help'), false)
    assert.equal(isLikelySlashCommand('好的'), false)
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

describe('ChannelRunner mention gate', () => {
  // Regression: Phase 25 post-approval text replay (preheatAndWelcomeOnApproval
  // → handleMessage(synthetic message)) was silently dropped after b5f16a7
  // made the Feishu mention gate strict. Dogfood stderr:
  //   [preheat-on-approval] zouyicheng: replaying pre-approval text (2 chars) ...
  //   [feishu] drop non-mention msg in group oc_4e92...
  // The replay text is system-injected from `lastApplicantText`; the user
  // sent it BEFORE pairing, so it doesn't carry an @bot mention and the
  // mention-gate check is meaningless for it.
  it('non-synthetic group message without mention is dropped at the mention gate', async () => {
    const strategy = installFakeStrategy('feishu')
    const runner = new ChannelRunner(strategy)
    let mentionCheckCalls = 0
    let allowedChecks = 0
    strategy.isMessageTargeted = () => {
      mentionCheckCalls += 1
      return false
    }
    const origAllowed = strategy.isMessageAllowed!
    strategy.isMessageAllowed = (m) => {
      allowedChecks += 1
      return origAllowed(m)
    }
    await runner.handleMessage(makeFakeFeishuMessage({
      sender: 'ou_alice',
      text: 'hello',
      chatType: 'group',
    }))
    assert.equal(mentionCheckCalls, 1)
    assert.equal(allowedChecks, 0, 'must not progress past the mention gate')
  })

  it('synthetic message bypasses the mention gate even when isMessageTargeted=false', async () => {
    await createUser('alice')
    await addLink('alice', 'feishu:ou_alice')
    const strategy = installFakeStrategy('feishu')
    const runner = new ChannelRunner(strategy)
    let mentionCheckCalls = 0
    strategy.isMessageTargeted = () => {
      mentionCheckCalls += 1
      return false
    }
    const synthetic: NormalizedChannelMessage = {
      ...makeFakeFeishuMessage({
        sender: 'ou_alice',
        text: 'hello',
        chatType: 'group',
      }),
      synthetic: true,
    }
    await runner.handleMessage(synthetic)
    assert.equal(
      mentionCheckCalls,
      0,
      'synthetic must short-circuit before the mention gate is consulted',
    )
  })
})

describe('ChannelRunner in-flight slash routing', () => {
  // Smoke-cover the regression behind the 2026-05-08 dogfood incident
  // (group session feishu:group:oc_4e92...:ou_7f0fb...): with a session
  // marked in-flight, write-style slashes ("/mode auto", "/rules allow X",
  // ...) were swept into the interjection queue, packed into the next
  // <user-interjection> block, and the LLM received "/mode auto" as natural
  // language — dispatchChannelSlash never ran. The interjection-guard now
  // checks isLikelySlashCommand BEFORE consulting the queue, so any text
  // starting with "/" routes to the in-lock dispatchChannelSlash path.
  it('does not push a write slash into the interjection queue while in-flight', async () => {
    await createUser('alice')
    await addLink('alice', 'feishu:ou_alice')

    const { channelInterjectionQueue } = await import('./feishu/interjection-queue.js')
    const { channelSessionLock } = await import('./session-lock.js')
    const strategy = installFakeStrategy('feishu')
    const runner = new ChannelRunner(strategy)
    // Stub resolveSessionId so handleMessage's mainSessionId matches the
    // string we mark in-flight below; default fake resolver returns chatId.
    const mainSessionId = 'feishu-alice-main'
    strategy.resolveSessionId = () => mainSessionId

    // Externally mark the session as in-flight AND hold its lock so the
    // turn never makes progress past `runExclusive` — handleMessage routes
    // by the synchronous interjection-guard check before any await, so this
    // is enough to prove the routing decision without standing up a full
    // LLM/runtime stack.
    channelInterjectionQueue.markInFlight(mainSessionId)
    let releaseHold: (() => void) | undefined
    const heldLock = channelSessionLock.runExclusive(
      mainSessionId,
      () => new Promise<void>(resolve => {
        releaseHold = resolve
      }),
    )

    const slashMessage = makeFakeFeishuMessage({
      sender: 'ou_alice',
      text: '/mode auto',
      chatId: mainSessionId,
    })
    // handleMessage will await runExclusive forever (the held lock); fire
    // and forget, then probe the queue state on the next microtask. The
    // synchronous interjection-guard runs before any await, so the decision
    // is already locked in by the time we yield.
    void runner.handleMessage(slashMessage)
    await delay(20)

    assert.equal(
      channelInterjectionQueue.size(mainSessionId),
      0,
      'write slash must not be pushed into the interjection queue',
    )
    assert.equal(
      strategy.notices.find(n => n.messageId === slashMessage.messageId),
      undefined,
      'no interjection.acked notice should be produced for a slash',
    )

    // Cleanup: release the lock and the in-flight marker so the suspended
    // handleMessage can unwind without leaking into the next test.
    channelInterjectionQueue.unmarkInFlight(mainSessionId)
    releaseHold?.()
    await heldLock.catch(() => {})
  })

  it('still queues bare chat as an interjection while in-flight', async () => {
    await createUser('alice')
    await addLink('alice', 'feishu:ou_alice')

    const { channelInterjectionQueue } = await import('./feishu/interjection-queue.js')
    const { channelSessionLock } = await import('./session-lock.js')
    const strategy = installFakeStrategy('feishu')
    const runner = new ChannelRunner(strategy)
    const mainSessionId = 'feishu-alice-chat-only'
    strategy.resolveSessionId = () => mainSessionId

    channelInterjectionQueue.markInFlight(mainSessionId)
    let releaseHold: (() => void) | undefined
    const heldLock = channelSessionLock.runExclusive(
      mainSessionId,
      () => new Promise<void>(resolve => {
        releaseHold = resolve
      }),
    )

    const chatMessage = makeFakeFeishuMessage({
      sender: 'ou_alice',
      text: '顺便帮我查一下天气',
      chatId: mainSessionId,
    })
    await runner.handleMessage(chatMessage)

    assert.equal(
      channelInterjectionQueue.size(mainSessionId),
      1,
      'bare chat must still be pushed into the interjection queue',
    )

    channelInterjectionQueue.unmarkInFlight(mainSessionId)
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

describe('formatChannelUserText', () => {
  it('prefixes Feishu group messages with the resolved sender name', async () => {
    const strategy = installFakeStrategy('feishu')
    strategy.resolveSenderName = async (_openId, mentions) =>
      mentions?.get('ou_alice') ?? 'fallback'
    const text = await formatChannelUserText(
      strategy,
      {
        channel: 'feishu',
        eventId: 'evt',
        chatId: 'oc_group',
        senderOpenId: 'ou_alice',
        chatType: 'group',
        messageId: 'om',
        feishuMentions: [{ openId: 'ou_alice', name: '张三' }],
        text: 'hello',
      },
      null,
    )

    assert.equal(text, '[张三] hello')
  })

  it('does not prefix Feishu DM messages', async () => {
    const strategy = installFakeStrategy('feishu')
    strategy.resolveSenderName = async () => '张三'
    const text = await formatChannelUserText(
      strategy,
      {
        channel: 'feishu',
        eventId: 'evt',
        chatId: 'oc_dm',
        senderOpenId: 'ou_alice',
        chatType: 'p2p',
        messageId: 'om',
        text: 'hello',
      },
      null,
    )

    assert.equal(text, 'hello')
  })
})

describe('ChannelRunner pairing branch', () => {
  // Pairing branch tests stop short before any LLM / runtime acquire — the
  // unpaired sender path returns null from resolveMessageUser, so handleMessage
  // exits before entering the channel session lock + runtime pool. That keeps
  // these tests free of LLM stubs while still exercising the full dispatch:
  // already-pending → waiting card; rate-limited → cooldown card; fresh →
  // application card; admin without feishu binding → legacy text fallback.

  // Lock locale so assertions on the cn i18n strings are deterministic.
  beforeEach(() => {
    setLang('cn')
  })

  function makePairingStrategy(opts?: {
    hasApplicationHook?: boolean
    hasWaitingHook?: boolean
    hasCooldownHook?: boolean
    hasNoticeToOpenIdHook?: boolean
  }): {
    strategy: ChannelRunnerStrategy
    notices: Array<{ messageId: string; text: string }>
    dmNotices: Array<{ applicantOpenId: string; text: string }>
    appCalls: Array<{ applicantOpenId: string; applicantName?: string; applicantEmail?: string; applicantUserId?: string }>
    waitCalls: Array<{ code: string; applicantName?: string }>
    cooldownCalls: Array<{ elapsedMinutes: number; remainMinutes: number }>
    senderInfo: Map<string, { name?: string; email?: string; userId?: string }>
  } {
    const notices: Array<{ messageId: string; text: string }> = []
    const dmNotices: Array<{ applicantOpenId: string; text: string }> = []
    const appCalls: Array<{
      applicantOpenId: string
      applicantName?: string
      applicantEmail?: string
      applicantUserId?: string
    }> = []
    const waitCalls: Array<{ code: string; applicantName?: string }> = []
    const cooldownCalls: Array<{ elapsedMinutes: number; remainMinutes: number }> = []
    const senderInfo = new Map<string, { name?: string; email?: string; userId?: string }>()

    const strategy: ChannelRunnerStrategy = {
      channelId: 'feishu',
      cwd: process.cwd(),
      permissionMode: 'default',
      isMessageAllowed: () => true,
      resolveSessionId: (_message, userId) => `feishu-${userId}`,
      buildChannelPrompt: () => 'fake',
      async sendReply() {},
      async sendNotice(message, _kind, text) {
        notices.push({ messageId: message.messageId, text })
      },
      async fetchSenderInfo(peerId) {
        return senderInfo.get(peerId)
      },
    }
    if (opts?.hasNoticeToOpenIdHook !== false) {
      strategy.sendNoticeToOpenId = async ({ applicantOpenId, content }) => {
        dmNotices.push({ applicantOpenId, text: content })
      }
    }
    if (opts?.hasApplicationHook !== false) {
      strategy.renderPairingApplicationCard = async input => {
        appCalls.push({
          applicantOpenId: input.applicantOpenId,
          applicantName: input.applicantName,
          applicantEmail: input.applicantEmail,
          applicantUserId: input.applicantUserId,
        })
      }
    }
    if (opts?.hasWaitingHook !== false) {
      strategy.renderPairingWaitingCard = async input => {
        waitCalls.push({ code: input.code, applicantName: input.applicantName })
      }
    }
    if (opts?.hasCooldownHook !== false) {
      strategy.renderPairingCooldownCard = async input => {
        cooldownCalls.push({
          elapsedMinutes: input.elapsedMinutes,
          remainMinutes: input.remainMinutes,
        })
      }
    }
    return { strategy, notices, dmNotices, appCalls, waitCalls, cooldownCalls, senderInfo }
  }

  it('renders the application card when admin has a feishu binding and the sender is fresh', async () => {
    await createUser('admin')
    const { setAdmin } = await import('../identity/store.js')
    await setAdmin('admin')
    await addLink('admin', 'feishu:ou_admin')

    const harness = makePairingStrategy()
    harness.senderInfo.set('ou_user', { name: 'Alice', email: 'alice@x.com', userId: 'abcd1234' })
    const runner = new ChannelRunner(harness.strategy)
    await runner.handleMessage(makeFakeFeishuMessage({ sender: 'ou_user', text: 'hello' }))

    assert.equal(harness.appCalls.length, 1, 'application card hook fires once')
    assert.equal(harness.appCalls[0].applicantOpenId, 'ou_user')
    assert.equal(harness.appCalls[0].applicantName, 'Alice')
    assert.equal(harness.appCalls[0].applicantEmail, 'alice@x.com')
    assert.equal(harness.appCalls[0].applicantUserId, 'abcd1234')
    assert.equal(harness.waitCalls.length, 0)
    assert.equal(harness.cooldownCalls.length, 0)
    assert.equal(harness.notices.length, 0, 'no text fallback when card path is live')
  })

  it('re-renders the waiting card when sender already has a pending entry', async () => {
    await createUser('admin')
    const { setAdmin } = await import('../identity/store.js')
    await setAdmin('admin')
    await addLink('admin', 'feishu:ou_admin')
    const { generateOrReusePending } = await import('../identity/pairing.js')
    const { code } = await generateOrReusePending('feishu', 'ou_user', 'Alice')

    const harness = makePairingStrategy()
    const runner = new ChannelRunner(harness.strategy)
    await runner.handleMessage(makeFakeFeishuMessage({ sender: 'ou_user', text: 'hello again' }))

    assert.equal(harness.waitCalls.length, 1, 'waiting card hook fires for existing pending')
    assert.equal(harness.waitCalls[0].code, code)
    assert.equal(harness.waitCalls[0].applicantName, 'Alice')
    assert.equal(harness.appCalls.length, 0, 'no fresh application card when pending exists')
  })

  it('renders the cooldown card when sender is rate-limited', async () => {
    await createUser('admin')
    const { setAdmin } = await import('../identity/store.js')
    await setAdmin('admin')
    await addLink('admin', 'feishu:ou_admin')
    const { generateOrReusePending, approveCode } = await import('../identity/pairing.js')
    // Generate then immediately consume so rate-limits.json is set but
    // pending.json is empty — emulates a fresh reject flow's cooldown.
    const { code } = await generateOrReusePending('feishu', 'ou_user')
    await approveCode(code)

    const harness = makePairingStrategy()
    const runner = new ChannelRunner(harness.strategy)
    await runner.handleMessage(makeFakeFeishuMessage({ sender: 'ou_user', text: 'hi again' }))

    assert.equal(harness.cooldownCalls.length, 1, 'cooldown card hook fires when rate-limited')
    assert.ok(
      harness.cooldownCalls[0].remainMinutes > 0 &&
      harness.cooldownCalls[0].remainMinutes <= 10,
      `remain minutes within (0, 10], got ${harness.cooldownCalls[0].remainMinutes}`,
    )
    assert.equal(harness.appCalls.length, 0)
    assert.equal(harness.waitCalls.length, 0)
  })

  it('routes bootstrap text notice to applicant DM when admin has no feishu binding', async () => {
    // The original Phase 25 fallback echoed the welcome+code+freshness back
    // into the inbound chat via sendNotice(message, ...). For group inbounds
    // that leaked applicant identity / pairing code to the entire group.
    // 2026-05-08 fix: when sendNoticeToOpenId is wired, runner pushes
    // pairing-bootstrap notices to applicant DM instead.
    await createUser('admin')
    const { setAdmin } = await import('../identity/store.js')
    await setAdmin('admin')
    // Intentionally no addLink for feishu — admin paired only via terminal.

    const harness = makePairingStrategy()
    const runner = new ChannelRunner(harness.strategy)
    await runner.handleMessage(makeFakeFeishuMessage({ sender: 'ou_user', text: 'hello' }))

    assert.equal(harness.appCalls.length, 0, 'no card path when admin lacks feishu binding')
    assert.equal(harness.waitCalls.length, 0)
    assert.equal(harness.cooldownCalls.length, 0)
    assert.equal(harness.notices.length, 0, 'NO in-chat echo (would leak in groups)')
    assert.equal(harness.dmNotices.length, 1, 'pairing notice routed to applicant DM')
    assert.equal(harness.dmNotices[0].applicantOpenId, 'ou_user')
    assert.match(harness.dmNotices[0].text, /配对码|approve/)
  })

  it('bootstrap fallback also stashes applicant text + chatId + chatType on the new pending entry for replay', async () => {
    // The 2026-05-08 issue-3 fix added updatePendingApplicantText only on
    // the card paths (existing-pending + applyConfirm promotion). Real
    // dogfood: admin self-pairing via group @ never hits either of those —
    // it goes straight through the bootstrap fallback `try` block when
    // canRenderPairingCard is false. Without stashing on this path, the
    // pending entry's lastApplicantText stays undefined and post-approve
    // replay silently skips.
    //
    // Beyond text, replay also needs chatId + chatType so it can route
    // back to the chat where the user originally @-mentioned the bot
    // (group → group, DM → DM). All three must be stashed together.
    await createUser('admin')
    const { setAdmin } = await import('../identity/store.js')
    await setAdmin('admin')

    const harness = makePairingStrategy()
    const runner = new ChannelRunner(harness.strategy)
    await runner.handleMessage(
      makeFakeFeishuMessage({
        sender: 'ou_user',
        text: '请帮我看一下日志',
        chatId: 'oc_real_group',
        chatType: 'group',
      }),
    )

    const { listPending } = await import('../identity/pairing.js')
    const pending = await listPending()
    assert.equal(pending.length, 1, 'bootstrap fallback created the pending entry')
    assert.equal(pending[0].lastApplicantText, '请帮我看一下日志', 'applicant text stashed for replay')
    assert.equal(pending[0].lastApplicantChatId, 'oc_real_group', 'origin chatId stashed')
    assert.equal(pending[0].lastApplicantChatType, 'group', 'origin chatType stashed (drives Phase 26 sessionId routing)')
    assert.ok(pending[0].lastApplicantTextAt, 'stash timestamp recorded')
  })

  it('falls back to in-chat notice when sendNoticeToOpenId hook is absent (legacy strategy)', async () => {
    // Channels without a "send to specific user without an inbound" surface
    // (or future test stubs that omit the hook) keep the old behavior so the
    // applicant is never silently ignored. This is the only allowed
    // in-chat path for pairing notices in 2026-05-08+.
    await createUser('admin')
    const { setAdmin } = await import('../identity/store.js')
    await setAdmin('admin')

    const harness = makePairingStrategy({ hasNoticeToOpenIdHook: false })
    const runner = new ChannelRunner(harness.strategy)
    await runner.handleMessage(makeFakeFeishuMessage({ sender: 'ou_user', text: 'hello' }))

    assert.equal(harness.dmNotices.length, 0)
    assert.equal(harness.notices.length, 1, 'in-chat fallback when strategy lacks DM hook')
    assert.match(harness.notices[0].text, /配对码|approve/)
  })

  it('routes bootstrap notice to DM even when strategy lacks the application card hook', async () => {
    // canRenderPairingCard depends on { adminFeishuOpenId, application,
    // waiting } — missing application hook drops to bootstrap fallback even
    // with admin bound. DM route still wins.
    await createUser('admin')
    const { setAdmin } = await import('../identity/store.js')
    await setAdmin('admin')
    await addLink('admin', 'feishu:ou_admin')

    const harness = makePairingStrategy({ hasApplicationHook: false })
    const runner = new ChannelRunner(harness.strategy)
    await runner.handleMessage(makeFakeFeishuMessage({ sender: 'ou_user', text: 'hello' }))

    assert.equal(harness.appCalls.length, 0)
    assert.equal(harness.notices.length, 0)
    assert.equal(harness.dmNotices.length, 1, 'DM route still wins')
    assert.equal(harness.dmNotices[0].applicantOpenId, 'ou_user')
  })
})
