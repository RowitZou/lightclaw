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
import { setAbortControllerForSession } from '../state.js'
import { ensureChainAbortPropagationSubscription, resetChainAbortPropagationForTest } from '../agents/hooks/chain-abort-propagation.js'
import { getSignalRouter } from '../signal-bus/router.js'
import type { AgentSignal } from '../signal-bus/types.js'
import type { Runtime } from '../runtime/types.js'
import { channelInterjectionQueue } from './feishu/interjection-queue.js'
import type { InterjectionEntry } from './feishu/interjection-queue.js'

import {
  applyAttachmentMaterialization,
  buildLeftoverReplayMessage,
  ChannelRunner,
  formatChannelUserText,
  renderQuotedMessageBlock,
  type ChannelRunnerStrategy,
} from './runner.js'
import type {
  MaterializedAttachment,
  NormalizedChannelMessage,
  PendingAttachment,
} from './types.js'

const ENV_KEYS = [
  'LIGHTCLAW_DEFAULT_MODEL',
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
  resetChainAbortPropagationForTest()
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

describe('ChannelRunner terminal routing', () => {
  it('accepts approved terminal senders instead of silently dropping them', async () => {
    await createUser('alice')
    await addLink('alice', 'terminal:alice')

    const strategy = installFakeStrategy('terminal')
    const runner = new ChannelRunner(strategy)
    await runner.handleMessage({
      channel: 'terminal',
      eventId: 'event-terminal-alice',
      chatId: 'terminal-run',
      senderOpenId: 'alice',
      senderKey: 'terminal:alice',
      chatType: 'p2p',
      messageId: 'msg-terminal-alice',
      text: '/help',
      synthetic: true,
    })

    assert.equal(strategy.replies.length + strategy.notices.length, 1)
  })
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

describe('ChannelRunner per-message context hydration', () => {
  // Regression guard for the 2026-05-19 group dogfood bug: a feishuSecretary
  // worker dispatched from a group main session called FeishuCreateFile and
  // got permission_grants.chat = 'skipped-not-group' even though the inbound
  // was a real group message. Root cause was the runner's resetSessionContext
  // hydration path: the placeholder ctx populated resourceGrantTarget from
  // strategy.resolveResourceGrantTarget, then Object.assign with a freshly
  // built resolvedContext (which has no resourceGrantTarget) clobbered it
  // back to undefined. permissionApprover and channelFileSender were already
  // pinned and restored — this test pins down that resourceGrantTarget joins
  // the same survivor list.
  it('resetSessionContext returns a resolvedContext with resourceGrantTarget undefined (drives the need to pin)', async () => {
    const { resetSessionContext } = await import('../init.js')
    await createUser('alice')
    await addLink('alice', 'feishu:ou_alice')
    const { sessionContext: resolved } = await resetSessionContext({
      cwd: tmpHome,
      channel: 'feishu',
      sessionId: 'feishu:group:oc_X:ou_Y',
      currentUserId: 'alice',
    })
    assert.equal(resolved.resourceGrantTarget, undefined)
  })

  it('preserves the placeholder resourceGrantTarget across Object.assign + pin-restore', async () => {
    const { createEmptySessionContext, runWithSessionContext } = await import('../session-context.js')
    const { resetSessionContext } = await import('../init.js')
    await createUser('alice')
    await addLink('alice', 'feishu:ou_alice')
    const grantTarget = { chatId: 'oc_4e92', senderOpenId: 'ou_7f0fb' }
    const placeholder = createEmptySessionContext({
      sessionId: 'feishu:group:oc_4e92:ou_7f0fb',
      currentUserId: 'alice',
      channel: 'feishu',
      resourceGrantTarget: grantTarget,
    })
    await runWithSessionContext(placeholder, async () => {
      const { sessionContext: resolved } = await resetSessionContext({
        cwd: tmpHome,
        channel: 'feishu',
        sessionId: 'feishu:group:oc_4e92:ou_7f0fb',
        currentUserId: 'alice',
      })
      const pinnedApprover = placeholder.permissionApprover
      const pinnedChannelFileSender = placeholder.channelFileSender
      const pinnedResourceGrantTarget = placeholder.resourceGrantTarget
      Object.assign(placeholder, resolved)
      placeholder.permissionApprover = pinnedApprover
      placeholder.channelFileSender = pinnedChannelFileSender
      placeholder.resourceGrantTarget = pinnedResourceGrantTarget
      assert.deepEqual(placeholder.resourceGrantTarget, grantTarget)
    })
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
    ensureChainAbortPropagationSubscription()
    strategy.resolveSessionId = () => 'feishu-alice'

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
    const ctrl = new AbortController()
    setAbortControllerForSession('feishu-alice', ctrl)
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
    assert.equal(ctrl.signal.aborted, true, '/stop aborts through the chain-abort subscriber')

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
    // Stop the message at the allowlist gate (runner.ts:367) so handleMessage
    // returns BEFORE acquiring a runtime / launching a query. The assertion
    // below only cares about the mention gate (runner.ts:351-357), which sits
    // strictly upstream of isMessageAllowed; whether the message ultimately
    // lands in query or is dropped at the allowlist doesn't change the
    // mentionCheckCalls outcome. Without this, the synthetic message walks
    // all the way to query() under the docker-backend test config and stalls
    // ~200s waiting on a fake LLM endpoint / image-readiness probe.
    const strategy = installFakeStrategy('feishu', { allowed: false })
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

describe('buildLeftoverReplayMessage synthetic-flag handling', () => {
  // Regression: a bg-result leftover interjection replayed through
  // handleMessage without `synthetic: true` carried its fake
  // `bg-<dispatchId>-<emittedAt>` messageId into im.message.reply /
  // messageReaction.create, producing 400 (code 99992354) on every fire.
  it('marks a bg-result leftover replay synthetic so its fake messageId never reaches reply/reactions', () => {
    const original = makeFakeFeishuMessage({ sender: 'ou_alice', text: 'original turn' })
    const entry: InterjectionEntry = {
      messageId: 'bg-zouyicheng-072b0023-1779274961191',
      senderOpenId: 'ou_alice',
      text: '<background-task-result>...</background-task-result>',
      arrivedAt: 1779274961191,
      source: 'background-task',
    }
    const replay = buildLeftoverReplayMessage(original, entry)
    assert.equal(replay.synthetic, true)
    assert.equal(replay.messageId, entry.messageId)
    assert.equal(replay.text, entry.text)
    assert.equal(replay.eventId, `replay-${entry.messageId}`)
  })

  it('keeps a real-user leftover replay non-synthetic so the reply still threads off the user message', () => {
    const original = makeFakeFeishuMessage({ sender: 'ou_alice', text: 'original turn' })
    const entry: InterjectionEntry = {
      messageId: 'om_realuser123',
      senderOpenId: 'ou_bob',
      text: 'a follow-up the user typed mid-flight',
      arrivedAt: 1779274961191,
      source: 'user',
    }
    const replay = buildLeftoverReplayMessage(original, entry)
    assert.equal(replay.synthetic, false)
    assert.equal(replay.messageId, 'om_realuser123')
    assert.equal(replay.senderOpenId, 'ou_bob')
  })

  it('overrides an inherited synthetic flag: a real-user leftover off a synthetic opener stays non-synthetic', () => {
    const original: NormalizedChannelMessage = {
      ...makeFakeFeishuMessage({ sender: 'ou_alice', text: 'synthetic opener' }),
      synthetic: true,
    }
    // No `source` field — a plain bare-chat interjection. Must resolve to
    // non-synthetic even though the opener it spreads from was synthetic.
    const entry: InterjectionEntry = {
      messageId: 'om_realuser456',
      senderOpenId: 'ou_alice',
      text: 'real user words',
      arrivedAt: 1779274961191,
    }
    const replay = buildLeftoverReplayMessage(original, entry)
    assert.equal(replay.synthetic, false)
  })
})

describe('ChannelRunner in-flight slash routing', () => {
  // A write slash ("/mode auto", "/rules allow X", ...) that lands while the
  // session's main turn is in flight must NOT be swept into the interjection
  // queue (the LLM would read "/mode auto" as natural language and
  // dispatchChannelSlash would never run). It is routed to the dedicated
  // pending-slash queue instead, which the in-flight turn drains and applies
  // at its next tool-call boundary (query.ts slashDrain). The routing returns
  // BEFORE acquiring the session lock, so the slash never stacks behind the
  // very turn it is meant to adjust.
  it('queues a write slash into the pending-slash queue while in-flight', async () => {
    await createUser('alice')
    await addLink('alice', 'feishu:ou_alice')

    const { channelInterjectionQueue } = await import('./feishu/interjection-queue.js')
    const { channelPendingSlashQueue } = await import('./feishu/pending-slash-queue.js')
    const strategy = installFakeStrategy('feishu')
    const runner = new ChannelRunner(strategy)
    // Stub resolveSessionId so handleMessage's mainSessionId matches the
    // string we mark in-flight below; default fake resolver returns chatId.
    const mainSessionId = 'feishu-alice-main'
    strategy.resolveSessionId = () => mainSessionId

    // Mark the session in-flight. The write slash is now routed to the
    // pending-slash queue and returns before reaching runExclusive, so no
    // held lock is needed to observe the routing decision.
    channelInterjectionQueue.markInFlight(mainSessionId)

    const slashMessage = makeFakeFeishuMessage({
      sender: 'ou_alice',
      text: '/mode auto',
      chatId: mainSessionId,
    })
    try {
      await runner.handleMessage(slashMessage)

      assert.equal(
        channelInterjectionQueue.size(mainSessionId),
        0,
        'write slash must not be pushed into the interjection queue',
      )
      assert.equal(
        channelPendingSlashQueue.size(mainSessionId),
        1,
        'write slash must be queued in the pending-slash queue',
      )
      // The queued-ack is sent as a first-person plain reply (not a
      // third-person system notice card) — first-person framing belongs in
      // the conversation stream, not in a "LightClaw 提示" notice card.
      assert.ok(
        strategy.replies.find(r => r.messageId === slashMessage.messageId),
        'the user should get a queued-ack reply for the slash',
      )
    } finally {
      // Cleanup so the in-flight marker / queue entry do not leak.
      channelInterjectionQueue.unmarkInFlight(mainSessionId)
      channelPendingSlashQueue.drain(mainSessionId)
    }
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
    const seenSignals: AgentSignal[] = []
    const unsubscribe = getSignalRouter().subscribe(
      { kind: 'role', id: 'main', sessionId: mainSessionId },
      signal => {
        seenSignals.push(signal)
      },
    )

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
    try {
      await runner.handleMessage(chatMessage)
    } finally {
      unsubscribe()
    }

    assert.equal(
      channelInterjectionQueue.size(mainSessionId),
      1,
      'bare chat must still be pushed into the interjection queue',
    )
    assert.ok(
      seenSignals.some(signal =>
        signal.kind === 'interjection' &&
        (signal as AgentSignal<'interjection'>).payload.text === '顺便帮我查一下天气',
      ),
      'bare in-flight chat should also emit an interjection signal',
    )

    channelInterjectionQueue.unmarkInFlight(mainSessionId)
    releaseHold?.()
    await heldLock
  })
})

describe('applyAttachmentMaterialization', () => {
  // Phase 24 contract: feishu raw onMessage attaches `pendingAttachments`,
  // ChannelRunner materializes each entry after pairing + runtime acquire
  // via the strategy hook. This block exercises the hook dispatcher in isolation
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
      message.pendingAttachments = [makePending()]
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

  it('returns [] and leaves text untouched when no pendingAttachments are set', async () => {
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

    assert.deepEqual(result, [])
    assert.equal(hookCalls, 0, 'hook should not run when pendingAttachments is empty')
    assert.equal(message.text, originalText, 'text must not be mutated')
  })

  it('warns to stderr and appends download-failed notice when strategy lacks the hook', async () => {
    const strategy = installFakeStrategy('feishu')
    // Explicitly absent: makes the missing-hook branch unambiguous.
    delete strategy.materializeAttachment
    const message = makeMessage()
    const stderr = captureStderr()

    let result: MaterializedAttachment[]
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

    assert.deepEqual(result, [])
    assert.match(message.text, /\[media download failed\]$/)
    assert.ok(
      stderr.lines.some(line =>
        line.includes('feishu got pendingAttachments without materializeAttachment hook'),
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

    let result: MaterializedAttachment[]
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

    assert.deepEqual(result, [{
      path: '/workspace/.lightclaw/inbox/oc_chat/test.jpg',
      mimeType: 'image/jpeg',
    }])
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

    let result: MaterializedAttachment[]
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

    assert.deepEqual(result, [])
    assert.match(message.text, /\[media download failed\]$/)
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

    let result: MaterializedAttachment[]
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

    assert.deepEqual(result, [])
    assert.match(message.text, /\[media download failed\]$/)
    assert.ok(
      stderr.lines.some(line =>
        line.includes('materializeAttachment threw') && line.includes('disk full'),
      ),
      `expected throw-path warn, got: ${JSON.stringify(stderr.lines)}`,
    )
  })

  it('materializes every entry in pendingAttachments[] and preserves order', async () => {
    const strategy = installFakeStrategy('feishu')
    const calls: PendingAttachment[] = []
    strategy.materializeAttachment = async input => {
      calls.push(input.pending)
      return {
        path: `/workspace/.lightclaw/inbox/oc_chat/${input.pending.fileName}`,
        mimeType: 'image/jpeg',
      }
    }
    const message = makeMessage({ withPending: false })
    message.pendingAttachments = [
      { kind: 'feishu-media', messageId: 'om_test', mediaKey: { kind: 'image', key: 'k1' }, fileName: 'a.jpg' },
      { kind: 'feishu-media', messageId: 'om_test', mediaKey: { kind: 'image', key: 'k2' }, fileName: 'b.jpg' },
      { kind: 'feishu-media', messageId: 'om_test', mediaKey: { kind: 'image', key: 'k3' }, fileName: 'c.jpg' },
    ]
    const stderr = captureStderr()

    let result: MaterializedAttachment[]
    try {
      result = await applyAttachmentMaterialization(strategy, message, makeRuntime(), 'feishu-alice')
    } finally {
      stderr.restore()
    }

    assert.equal(result.length, 3)
    assert.equal(result[0].path, '/workspace/.lightclaw/inbox/oc_chat/a.jpg')
    assert.equal(result[2].path, '/workspace/.lightclaw/inbox/oc_chat/c.jpg')
    assert.deepEqual(calls.map(c => c.fileName), ['a.jpg', 'b.jpg', 'c.jpg'])
    assert.equal(message.text, 'hello', 'no failure → no notice appended')
  })

  it('partially materializes: keeps successes, surfaces single notice for any failure', async () => {
    const strategy = installFakeStrategy('feishu')
    let n = 0
    strategy.materializeAttachment = async input => {
      n += 1
      if (input.pending.fileName === 'b.jpg') return null  // fail middle
      return { path: `/p/${input.pending.fileName}`, mimeType: 'image/jpeg' }
    }
    const message = makeMessage({ withPending: false })
    message.pendingAttachments = [
      { kind: 'feishu-media', messageId: 'om_test', mediaKey: { kind: 'image', key: 'k1' }, fileName: 'a.jpg' },
      { kind: 'feishu-media', messageId: 'om_test', mediaKey: { kind: 'image', key: 'k2' }, fileName: 'b.jpg' },
      { kind: 'feishu-media', messageId: 'om_test', mediaKey: { kind: 'image', key: 'k3' }, fileName: 'c.jpg' },
    ]
    const stderr = captureStderr()

    let result: MaterializedAttachment[]
    try {
      result = await applyAttachmentMaterialization(strategy, message, makeRuntime(), 'feishu-alice')
    } finally {
      stderr.restore()
    }

    assert.equal(n, 3, 'each pending attempted once')
    assert.equal(result.length, 2, 'two successes returned')
    assert.deepEqual(result.map(r => r.path), ['/p/a.jpg', '/p/c.jpg'])
    // Single download-failed notice regardless of N failures (N=1 here)
    assert.equal(
      (message.text.match(/\[media download failed\]/g) ?? []).length,
      1,
      'exactly one notice appended, not per-failure',
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

  it('renders quoted text before the current message', async () => {
    const strategy = installFakeStrategy('feishu')
    strategy.resolveSenderName = async () => 'Bob'
    const text = await formatChannelUserText(
      strategy,
      {
        channel: 'feishu',
        eventId: 'evt',
        chatId: 'oc_group',
        senderOpenId: 'ou_bob',
        chatType: 'group',
        messageId: 'om',
        text: 'please explain',
        quotedMessage: {
          author: 'Alice',
          text: 'the earlier point',
        },
      },
      null,
    )

    assert.equal(text, [
      '<quoted-message author="Alice">',
      '<text>the earlier point</text>',
      '</quoted-message>',
      '[Bob] please explain',
    ].join('\n'))
  })

  it('renders quoted attachments and marks quoted breadcrumbs', async () => {
    setLang('en')
    const strategy = installFakeStrategy('feishu')
    const text = await formatChannelUserText(
      strategy,
      {
        channel: 'feishu',
        eventId: 'evt',
        chatId: 'oc_dm',
        senderOpenId: 'ou_alice',
        chatType: 'p2p',
        messageId: 'om',
        text: 'translate it',
        quotedMessage: {
          author: 'Alice',
          attachedFileNames: ['om_parent-image-aa.jpg'],
        },
      },
      [{
        path: '/workspace/.lightclaw/inbox/oc_dm/om_parent-image-aa.jpg',
        mimeType: 'image/jpeg',
        quotedFromMessageId: 'om_parent',
      }],
    )

    assert.match(text, /<attached>om_parent-image-aa\.jpg<\/attached>/)
    // No fallbackPaths passed → defaults to `inline` status marker.
    assert.match(text, /- inline \(already visible[^,]*, path: .*om_parent-image-aa\.jpg \(via quoted message\)/)
  })

  it('marks inline-vs-pending paths via fallbackPaths', async () => {
    setLang('en')
    const strategy = installFakeStrategy('feishu')
    const inlineAtt = {
      path: '/workspace/.lightclaw/inbox/oc_dm/om-image-aa.jpg',
      mimeType: 'image/jpeg' as const,
    }
    const pendingAtt = {
      path: '/workspace/.lightclaw/inbox/oc_dm/om-image-bb.pdf',
      mimeType: 'application/pdf' as const,
    }
    const text = await formatChannelUserText(
      strategy,
      {
        channel: 'feishu',
        eventId: 'evt',
        chatId: 'oc_dm',
        senderOpenId: 'ou_alice',
        chatType: 'p2p',
        messageId: 'om',
        text: 'two attachments',
      },
      [inlineAtt, pendingAtt],
      [pendingAtt],
    )
    assert.match(text, /- inline \(already visible[^,]*, path: .*om-image-aa\.jpg/)
    assert.match(text, /- pending \(not yet read[^,]*, path: .*om-image-bb\.pdf/)
  })

  it('renders bot self-quotes as LightClaw and escapes quoted body', () => {
    setLang('en')
    assert.equal(renderQuotedMessageBlock({
      author: 'Ignored',
      authorIsBot: true,
      text: '</quoted-message>',
      truncated: true,
    }), [
      '<quoted-message author="LightClaw">',
      '<text>&lt;/quoted-message&gt;...(truncated)</text>',
      '</quoted-message>',
    ].join('\n'))
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

  it('bootstrap fallback stashes chatId + chatType even when applicant @-ed bot with empty body', async () => {
    // 2026-05-09 dogfood: admin's first @ in group was just `@LightClaw`
    // with no body. After botStripId the message text is empty. The old
    // updatePendingApplicantText short-circuited on empty text, dropping
    // chatId / chatType too — post-approve replay then had no way to
    // route. We now stash routing fields independently of text so an
    // empty replay still lands in the originating group; the LLM greets
    // via the bare `[senderName] ` prefix per 9af7001.
    await createUser('admin')
    const { setAdmin } = await import('../identity/store.js')
    await setAdmin('admin')

    const harness = makePairingStrategy()
    const runner = new ChannelRunner(harness.strategy)
    await runner.handleMessage(
      makeFakeFeishuMessage({
        sender: 'ou_user',
        text: '',
        chatId: 'oc_real_group',
        chatType: 'group',
      }),
    )

    const { listPending } = await import('../identity/pairing.js')
    const pending = await listPending()
    assert.equal(pending.length, 1, 'bootstrap fallback created the pending entry')
    assert.equal(pending[0].lastApplicantText, undefined, 'no body to stash')
    assert.equal(pending[0].lastApplicantChatId, 'oc_real_group', 'origin chatId stashed for routing')
    assert.equal(pending[0].lastApplicantChatType, 'group', 'origin chatType stashed for routing')
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

describe('ChannelRunner recall handling', () => {
  it('aborts the in-flight turn whose opener was recalled and posts a non-error notice', async () => {
    const strategy = installFakeStrategy('feishu')
    const runner = new ChannelRunner(strategy)
    const sessionId = 'feishu:group:oc_recall_abort:ou_alice'
    // Simulate a turn in flight: opener registered + an abort controller
    // installed for the sessionId (mirrors markInFlight + beginQuery).
    channelInterjectionQueue.markInFlight(sessionId, 'om_opener')
    const controller = new AbortController()
    setAbortControllerForSession(sessionId, controller)
    try {
      await runner.handleRecall({ messageId: 'om_opener', chatId: 'oc_recall_abort' })
      assert.equal(controller.signal.aborted, true, 'in-flight turn must be aborted')
      assert.equal(strategy.chatNotices.length, 1)
      // 'info' kind => wathet card, never the red error card.
      assert.equal(strategy.chatNotices[0]!.kind, 'info')
      assert.equal(strategy.chatNotices[0]!.chatId, 'oc_recall_abort')
    } finally {
      channelInterjectionQueue.unmarkInFlight(sessionId)
    }
  })

  it('drops a recalled queued interjection without aborting or notifying', async () => {
    const strategy = installFakeStrategy('feishu')
    const runner = new ChannelRunner(strategy)
    const sessionId = 'feishu:dm:oc_recall_interjection'
    channelInterjectionQueue.push(sessionId, {
      messageId: 'om_interjection',
      senderOpenId: 'ou_alice',
      text: 'mid-flight follow-up',
      arrivedAt: Date.now(),
    })
    try {
      await runner.handleRecall({
        messageId: 'om_interjection',
        chatId: 'oc_recall_interjection',
      })
      assert.equal(channelInterjectionQueue.size(sessionId), 0, 'queued interjection dropped')
      assert.equal(strategy.chatNotices.length, 0, 'no notice for a not-yet-running interjection')
    } finally {
      channelInterjectionQueue.drain(sessionId)
    }
  })

  it('is a no-op when the recalled message is not tracked', async () => {
    const strategy = installFakeStrategy('feishu')
    const runner = new ChannelRunner(strategy)
    await runner.handleRecall({ messageId: 'om_unknown', chatId: 'oc_x' })
    assert.equal(strategy.chatNotices.length, 0)
  })
})

describe('ChannelRunner finally — background-task fire-and-forget contract', () => {
  // Regression pin for the 2026-05-23 dogfood bug: user said "hi" → bot
  // replied → user said the next thing → silence until /stop. Root cause:
  // a34c39a (2026-05-02) replaced an earlier `drainPendingExtraction(60_000)`
  // inside the in-flight lock body with a "fire-and-forget" comment but kept
  // the existing `await awaitBackgroundTasks()` on the very next line. The
  // stale await held the session's in-flight marker for the entire memory
  // extraction (slow on codex / reasoning models — 17s+, occasionally wedged
  // until aborted), so user follow-ups arriving in that window were misrouted
  // to the interjection queue. The turn had already `end_turn`-ed so nothing
  // consumed them; the leftover-rescue path eventually replays them as a
  // fresh turn, but only AFTER awaitBackgroundTasks finally returns — which
  // in the dogfood case required /stop to abort the wedged extraction.
  //
  // A behavioral e2e test would need a fake provider + fake runtime + full
  // ChannelRunner.handleMessage query path wired up — heavy compared to the
  // one-line fix. This pinning test catches the exact regression shape (an
  // `await awaitBackgroundTasks()` inside runner.ts) directly. If a future
  // legitimate use needs awaitBackgroundTasks here, refactor so the await
  // happens AFTER unmarkInFlight runs (i.e. outside the runExclusive body),
  // and update this test to enforce that placement instead of forbidding
  // the call outright.
  it('runner.ts does not inline-await awaitBackgroundTasks inside the session lock', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const runnerSrc = readFileSync(
      fileURLToPath(new URL('./runner.ts', import.meta.url)),
      'utf8',
    )
    const offending = runnerSrc.match(/\bawait\s+awaitBackgroundTasks\s*\(/g)
    assert.equal(
      offending,
      null,
      'runner.ts must NOT contain `await awaitBackgroundTasks(...)` — it ' +
      'would hold the channel in-flight marker for the entire background ' +
      'task duration (memory extraction on codex/reasoning models can wedge ' +
      'indefinitely), misrouting user follow-ups to the interjection queue ' +
      'after end_turn. Background tasks are fire-and-forget here; the CLI ' +
      'exit path (cli.ts SIGINT/SIGTERM/finally) drains them at shutdown.',
    )
  })
})
