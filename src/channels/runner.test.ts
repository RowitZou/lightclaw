import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import {
  installFakeStrategy,
  makeFakeFeishuMessage,
} from '../__tests__/concurrency-helpers.js'
import { createUser, addLink, setAdmin } from '../identity/store.js'
import { setIdentityPreference } from '../identity/preferences.js'
import { appendMessages, saveMeta } from '../session/storage.js'
import { createAssistantMessage, createUserMessage } from '../messages.js'
import {
  createEmptySessionContext,
  runWithSessionContext,
} from '../session-context.js'
import { setStreamChatForTest } from '../query.js'
import { setLightclawHomeOverride } from '../paths.js'
import { setLang } from '../i18n/index.js'
import { setAbortControllerForSession } from '../state.js'
import type { StreamEvent } from '../types.js'
import { ensureChainAbortPropagationSubscription, resetChainAbortPropagationForTest } from '../agents/hooks/chain-abort-propagation.js'
import { getSignalRouter } from '../signal-bus/router.js'
import type { AgentSignal } from '../signal-bus/types.js'
import type { Runtime } from '../runtime/types.js'
import { channelInterjectionQueue } from './feishu/interjection-queue.js'
import type { InterjectionEntry } from './feishu/interjection-queue.js'
import { createRootTaskRun } from '../taskrun/store.js'
import { recallRootIndex } from '../taskrun/recall-index.js'

import {
  applyAttachmentMaterialization,
  buildLeftoverReplayMessage,
  ChannelRunner,
  withFinalReplyMention,
  formatChannelUserText,
  renderQuotedMessageBlock,
  turnCardTargetForMessage,
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
    // /status was removed; it no longer fast-paths (falls through to chat).
    assert.equal(parseFastPathSlash('/status'), null)
    // PR5.9 B6: every retired top-level name is no longer fast-pathed — it
    // falls through to the lock path (→ dispatchChannelSlash → RENAMED hint),
    // so parseFastPathSlash returns null for all of them (read AND write
    // forms alike).
    assert.equal(parseFastPathSlash('/cost'), null)
    assert.equal(parseFastPathSlash('/mode'), null)
    assert.equal(parseFastPathSlash('/model'), null)
    assert.equal(parseFastPathSlash('/rules'), null)
    assert.equal(parseFastPathSlash('/rules list'), null)
    assert.equal(parseFastPathSlash('/auth list'), null)
    assert.equal(parseFastPathSlash('/user'), null)
    assert.equal(parseFastPathSlash('/user list'), null)
    assert.equal(parseFastPathSlash('/user pending'), null)
    assert.equal(parseFastPathSlash('/user feedback --page 2'), null)
    assert.equal(parseFastPathSlash('/mode auto'), null)
    assert.equal(parseFastPathSlash('/model claude-x'), null)
    assert.equal(parseFastPathSlash('/rules allow Bash(curl:*)'), null)
    assert.equal(parseFastPathSlash('/rules revoke 3'), null)
    assert.equal(parseFastPathSlash('/auth import codex'), null)
    assert.equal(parseFastPathSlash('/auth logout codex'), null)
    assert.equal(parseFastPathSlash('/user approve abc123'), null)
    assert.equal(parseFastPathSlash('/user remove bob'), null)
    assert.equal(parseFastPathSlash('/secret list'), null)
    assert.equal(parseFastPathSlash('/mount list'), null)
    // The retired bare /sandbox is gone; only /admin sandbox classifies now
    // (asserted in the /admin block below). All bare-/sandbox forms are null.
    assert.equal(parseFastPathSlash('/sandbox'), null)
    assert.equal(parseFastPathSlash('/sandbox status'), null)
    assert.equal(parseFastPathSlash('/sandbox prefetch'), null)
    assert.equal(parseFastPathSlash('/sandbox reset'), null)
    assert.equal(parseFastPathSlash('/feishu-workspace'), null)
    assert.equal(parseFastPathSlash('/feishu-workspace status'), null)
    // /system hub (PR5.9 B1): read nouns short-circuit, writes lock.
    assert.equal(parseFastPathSlash('/system'), 'read')
    assert.equal(parseFastPathSlash('/system key'), 'read')
    assert.equal(parseFastPathSlash('/system key list'), 'read')
    assert.equal(parseFastPathSlash('/system key status NAME'), 'read')
    assert.equal(parseFastPathSlash('/system mount'), 'read')
    assert.equal(parseFastPathSlash('/system mount list'), 'read')
    // Write verbs + the data noun must NOT fast-path.
    assert.equal(parseFastPathSlash('/system key set X v'), null)
    assert.equal(parseFastPathSlash('/system key enable X'), null)
    assert.equal(parseFastPathSlash('/system key disable X'), null)
    assert.equal(parseFastPathSlash('/system key rm X'), null)
    assert.equal(parseFastPathSlash('/system mount add /x'), null)
    assert.equal(parseFastPathSlash('/system mount rm /x'), null)
    assert.equal(parseFastPathSlash('/system data'), null)
    assert.equal(parseFastPathSlash('/system data import /x'), null)
    // /config hub (PR5.9 B2): bare hub + bare/`list` nouns are read; any
    // write verb (set / reset / add / rm / ...) falls through to the lock.
    assert.equal(parseFastPathSlash('/config'), 'read')
    assert.equal(parseFastPathSlash('/config model'), 'read')
    assert.equal(parseFastPathSlash('/config model list'), 'read')
    assert.equal(parseFastPathSlash('/config mode'), 'read')
    assert.equal(parseFastPathSlash('/config lang'), 'read')
    assert.equal(parseFastPathSlash('/config rule'), 'read')
    assert.equal(parseFastPathSlash('/config workspace'), 'read')
    assert.equal(parseFastPathSlash('/config endpoint'), 'read')
    assert.equal(parseFastPathSlash('/config codex'), 'read')
    // B3 nouns: backend + lane follow the same read/write split.
    assert.equal(parseFastPathSlash('/config backend'), 'read')
    assert.equal(parseFastPathSlash('/config backend list'), 'read')
    assert.equal(parseFastPathSlash('/config lane'), 'read')
    assert.equal(parseFastPathSlash('/config backend add x'), null)
    assert.equal(parseFastPathSlash('/config lane set worker m'), null)
    assert.equal(parseFastPathSlash('/config model set x'), null)
    assert.equal(parseFastPathSlash('/config model reset'), null)
    assert.equal(parseFastPathSlash('/config mode set auto'), null)
    assert.equal(parseFastPathSlash('/config lang set en'), null)
    assert.equal(parseFastPathSlash('/config rule add Bash(git:*)'), null)
    assert.equal(parseFastPathSlash('/config workspace set /x'), null)
    assert.equal(parseFastPathSlash('/config endpoint add-key a b'), null)
    // /admin hub (PR5.9 B4): read nouns short-circuit; write verbs lock.
    assert.equal(parseFastPathSlash('/admin'), 'read')
    assert.equal(parseFastPathSlash('/admin cost'), 'read')
    assert.equal(parseFastPathSlash('/admin cost --month 2026-06'), 'read')
    assert.equal(parseFastPathSlash('/admin user'), 'read')
    assert.equal(parseFastPathSlash('/admin user list'), 'read')
    assert.equal(parseFastPathSlash('/admin pairing'), 'read')
    assert.equal(parseFastPathSlash('/admin pairing list'), 'read')
    assert.equal(parseFastPathSlash('/admin feedback'), 'read')
    assert.equal(parseFastPathSlash('/admin feedback --page 2'), 'read')
    assert.equal(parseFastPathSlash('/admin ceiling'), 'read')
    assert.equal(parseFastPathSlash('/admin ceiling list'), 'read')
    assert.equal(parseFastPathSlash('/admin sandbox status'), 'read')
    assert.equal(parseFastPathSlash('/admin feishu-drive status'), 'read')
    assert.equal(parseFastPathSlash('/admin backend'), 'read')
    assert.equal(parseFastPathSlash('/admin endpoint'), 'read')
    assert.equal(parseFastPathSlash('/admin lane'), 'read')
    // /admin write verbs must NOT fast-path.
    assert.equal(parseFastPathSlash('/admin user rm bob'), null)
    assert.equal(parseFastPathSlash('/admin pairing approve abc'), null)
    assert.equal(parseFastPathSlash('/admin ceiling set bob auto'), null)
    assert.equal(parseFastPathSlash('/admin sandbox prefetch'), null)
    assert.equal(parseFastPathSlash('/admin sandbox reset'), null)
    assert.equal(parseFastPathSlash('/admin feishu-drive rm bob --y'), null)
    assert.equal(parseFastPathSlash('/admin backend add m --endpoint ep'), null)
    assert.equal(parseFastPathSlash('/admin endpoint add ep --type anthropic --key K'), null)
    assert.equal(parseFastPathSlash('/admin lane set worker m'), null)
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

  // Regression (dogfood 2026-06-16): a worker→main ask is enqueued
  // `source:'user'` (so the model reads it as a question to settle) but with a
  // synthetic `taskrun-ask-<id>` messageId + `taskrun:<id>` senderOpenId the
  // platform never saw. The pre-fix code keyed the synthetic decision on
  // `source`, so it marked this non-synthetic, the reply anchored on the fake
  // id (im.message.reply 400 / code 99992354) AND the create-fallback card
  // 400'd on the `taskrun:` at/person — the turn's answer was lost.
  it('marks a taskrun-ask leftover synthetic despite source:"user", and anchors on the opener', () => {
    const original = makeFakeFeishuMessage({ sender: 'ou_alice', text: 'look at the progress' })
    const entry: InterjectionEntry = {
      messageId: 'taskrun-ask-tr_abc-1779274961191',
      senderOpenId: 'taskrun:tr_abc',
      text: '<taskrun-ask childRunId="tr_abc">torch 2.10 or 2.11?</taskrun-ask>',
      arrivedAt: 1779274961191,
      source: 'user',
      synthetic: true,
    }
    const replay = buildLeftoverReplayMessage(original, entry)
    assert.equal(replay.synthetic, true, 'a synthetic entry must replay synthetic regardless of source')
    // It must carry the opener's real id as the anchor so a topic-group
    // synthetic create can still land — never the taskrun-ask fake id.
    assert.equal(replay.replyAnchorMessageId, original.messageId)
    assert.notEqual(replay.replyAnchorMessageId, entry.messageId)
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

  // Companion to the bare-chat interjection emoji ack: a write slash queued
  // while the session is in flight is acked with the SAME transient emoji
  // reaction, not a third-person text reply — so /mode auto mid-turn looks
  // identical in the UI to dropping a chat interjection.
  it('acks an in-flight queued slash with an emoji reaction instead of a text reply', async () => {
    await createUser('alice')
    await addLink('alice', 'feishu:ou_alice')

    const { channelInterjectionQueue } = await import('./feishu/interjection-queue.js')
    const { channelPendingSlashQueue } = await import('./feishu/pending-slash-queue.js')
    const strategy = installFakeStrategy('feishu')
    const ackCalls: string[] = []
    strategy.ackInterjection = async message => {
      ackCalls.push(message.messageId)
      return { messageId: message.messageId, reactionId: 'rx-slash-1' }
    }
    strategy.clearAck = async () => {}
    const runner = new ChannelRunner(strategy)
    const mainSessionId = 'feishu-alice-slash-react-ack'
    strategy.resolveSessionId = () => mainSessionId

    channelInterjectionQueue.markInFlight(mainSessionId)

    const slashMessage = makeFakeFeishuMessage({
      sender: 'ou_alice',
      text: '/mode auto',
      chatId: mainSessionId,
    })
    try {
      await runner.handleMessage(slashMessage)

      assert.deepEqual(ackCalls, [slashMessage.messageId], 'queued slash acked via emoji reaction')
      assert.equal(
        strategy.replies.length,
        0,
        'reaction ack must not also send a text reply',
      )
      assert.equal(
        channelPendingSlashQueue.size(mainSessionId),
        1,
        'write slash is still queued in the pending-slash queue',
      )
    } finally {
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

  it('acks an in-flight interjection with an emoji reaction instead of a text reply', async () => {
    await createUser('alice')
    await addLink('alice', 'feishu:ou_alice')

    const { channelInterjectionQueue } = await import('./feishu/interjection-queue.js')
    const { channelSessionLock } = await import('./session-lock.js')
    const strategy = installFakeStrategy('feishu')
    const ackCalls: string[] = []
    strategy.ackInterjection = async message => {
      ackCalls.push(message.messageId)
      return { messageId: message.messageId, reactionId: 'rx-1' }
    }
    strategy.clearAck = async () => {}
    const runner = new ChannelRunner(strategy)
    const mainSessionId = 'feishu-alice-react-ack'
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
      text: '顺便看一下天气',
      chatId: mainSessionId,
    })
    await runner.handleMessage(chatMessage)

    assert.deepEqual(ackCalls, [chatMessage.messageId], 'interjection acked via emoji reaction')
    assert.equal(
      strategy.replies.length,
      0,
      'reaction ack must not also send a text reply',
    )
    assert.equal(
      channelInterjectionQueue.size(mainSessionId),
      1,
      'interjection is still queued',
    )

    channelInterjectionQueue.unmarkInFlight(mainSessionId)
    releaseHold?.()
    await heldLock
  })
})

describe('ChannelRunner idle-when-dirty session-memory refresh (Feature A)', () => {
  // The production freeze: a task finished across short turns leaves SM frozen
  // at a stale mid-task snapshot because no single short turn crosses the
  // accumulation thresholds. Feature A force-flushes SM when the turn ends and
  // the session is idle + dirty. Pre-PR3 the runner never called the force path,
  // so a single short turn wrote nothing and this test's write signal never
  // fired (the required "fails on old code" property). The SM writer seam is
  // shared with query.ts's threshold-gated end-turn flush, but a single short
  // turn stays below threshold, so the force idle refresh is the only caller.
  it('force-flushes SM at the end of a short (below-threshold) turn', async () => {
    writeFileSync(
      path.join(tmpHome, 'config.json'),
      JSON.stringify({
        endpoints: { fake: { apiKey: 'sk-fake' } },
        models: {
          fake: { endpoint: 'fake', schema: 'anthropic', upstreamModel: 'claude-fake' },
        },
        defaultModel: 'fake',
        autoMemory: true,
        hooksEnabled: false,
        mcpEnabled: false,
        runtime: { backend: 'docker', docker: { image: 'lightclaw-test', autoPull: false } },
      }),
    )
    await createUser('alice')
    await addLink('alice', 'feishu:ou_alice')

    const { setSessionMemoryWriterForTest } = await import('../memory/session-memory.js')
    const strategy = installFakeStrategy('feishu')
    const runner = new ChannelRunner(strategy)
    const mainSessionId = 'feishu-alice-idle'
    strategy.resolveSessionId = () => mainSessionId

    // A trivial single end_turn — no tools, low tokens → below both thresholds,
    // so query.ts's own end-turn flush never fires the writer; only the idle
    // force refresh can.
    setStreamChatForTest(async function* (): AsyncGenerator<StreamEvent> {
      yield {
        type: 'stop',
        stopReason: 'end_turn',
        usage: { input_tokens: 8, output_tokens: 4 },
        content: [{ type: 'text', text: 'done' }],
      }
    } as unknown as Parameters<typeof setStreamChatForTest>[0])

    const written: string[] = []
    let signalWrite: () => void = () => {}
    const wrote = new Promise<void>(resolve => {
      signalWrite = resolve
    })
    setSessionMemoryWriterForTest(input => {
      written.push(input.sessionId)
      signalWrite()
      return Promise.resolve({ updated: true })
    })

    try {
      await runner.handleMessage(
        makeFakeFeishuMessage({
          sender: 'ou_alice',
          text: '任务做完了吗',
          chatId: mainSessionId,
        }),
      )
      // Race a settle so a genuine "did not fire" (pre-PR3) fails fast via the
      // node:test per-test timeout rather than hanging the whole suite.
      await Promise.race([wrote, delay(500)])
      assert.deepEqual(
        written,
        [mainSessionId],
        'a completed short turn force-flushes SM once under the session id',
      )
    } finally {
      setSessionMemoryWriterForTest(null)
      setStreamChatForTest(null)
    }
  })
})

describe('ChannelRunner history load under a leaked ambient SessionContext', () => {
  // Production shape (2026-07-03): channel socket handlers carry the startup
  // bootstrap SessionContext (AsyncLocalStorage propagates into callbacks whose
  // async resources were created inside that scope), so handleMessage's
  // pre-scope loadTranscript resolved the inbound user's sessionId into the
  // BOOTSTRAP identity's sessions dir → empty → the model received only the
  // current message. Writes ran inside the correctly-hydrated per-turn scope,
  // so transcripts kept growing on disk while every turn stayed amnesiac.
  it('a turn handled under a foreign ambient context still sends the persisted history to the model', async () => {
    await createUser('alice')
    await addLink('alice', 'feishu:ou_alice')

    const strategy = installFakeStrategy('feishu')
    const runner = new ChannelRunner(strategy)
    const sessionId = 'feishu:dm:oc_history'
    strategy.resolveSessionId = () => sessionId

    // A prior turn persisted where the channel turn itself writes: the
    // inbound user's own sessions dir.
    const aliceSessions = path.join(tmpHome, 'users', 'alice', 'sessions')
    const priorUser = createUserMessage('请翻译这封英文邮件', null)
    const priorAssistant = createAssistantMessage({
      content: [{ type: 'text', text: '好的，译文如下……' }],
      stopReason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 10 },
      parentUuid: priorUser.uuid,
    })
    await runWithSessionContext(
      createEmptySessionContext({ sessionsDir: aliceSessions }),
      () => appendMessages(sessionId, [priorUser, priorAssistant]),
    )

    const capturedWire: unknown[][] = []
    setStreamChatForTest(async function* (params: {
      messages: unknown[]
    }): AsyncGenerator<StreamEvent> {
      capturedWire.push(params.messages)
      yield {
        type: 'stop',
        stopReason: 'end_turn',
        usage: { input_tokens: 8, output_tokens: 4 },
        content: [{ type: 'text', text: 'ok' }],
      }
    } as unknown as Parameters<typeof setStreamChatForTest>[0])

    // The leaked scope: a context whose sessionsDir belongs to a DIFFERENT
    // identity, exactly what the bootstrap console context looks like to a
    // non-bootstrap user's inbound message.
    const leakedBootstrapCtx = createEmptySessionContext({
      sessionId: 'terminal-console',
      sessionsDir: path.join(tmpHome, 'users', 'admin-boot', 'sessions'),
    })
    try {
      await runWithSessionContext(leakedBootstrapCtx, () =>
        runner.handleMessage(
          makeFakeFeishuMessage({
            sender: 'ou_alice',
            text: '上面内容翻译成中文',
            chatId: sessionId,
          }),
        ),
      )
      assert.equal(capturedWire.length, 1, 'exactly one model call')
      const wire = capturedWire[0]!
      assert.ok(
        wire.length > 1,
        `model must receive the persisted history, got ${wire.length} message(s)`,
      )
      assert.match(
        JSON.stringify(wire[0]),
        /请翻译这封英文邮件/,
        'first wire message is the persisted prior turn',
      )
    } finally {
      setStreamChatForTest(null)
    }
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

describe('turnCardTargetForMessage', () => {
  const base = {
    channel: 'feishu' as const,
    eventId: 'evt',
    chatId: 'oc_group',
    senderOpenId: 'ou_alice',
    chatType: 'group',
  }

  it('gives a genuine inbound a turn card anchored on its own messageId', () => {
    const target = turnCardTargetForMessage({
      ...base,
      messageId: 'om_real',
      text: 'hello',
    })
    assert.deepEqual(target, { chatId: 'oc_group', replyAnchorMessageId: 'om_real' })
  })

  it('gives the post-approval replay a turn card anchored on the REAL origin id, not replay-<uuid>', () => {
    // The replay carries the user's real first message. It is synthetic only
    // so the platform-unseen replay-<uuid> short-circuits reply/reaction APIs
    // — its narration must still collect into a turn card (matching what every
    // later real inbound gets), anchored on the original @ message it carries.
    const target = turnCardTargetForMessage({
      ...base,
      messageId: 'replay-1234',
      replyAnchorMessageId: 'om_original_at',
      text: '@LightClaw do the thing',
      synthetic: true,
    })
    assert.ok(target, 'replay must get a turn card')
    assert.equal(
      target.replyAnchorMessageId,
      'om_original_at',
      'anchor on the real origin id the replay carries, never the platform-unseen replay-<uuid>',
    )
    assert.equal(target.chatId, 'oc_group')
  })

  it('creates against the chat (no anchor) for a DM-fallback replay that carries none', () => {
    const target = turnCardTargetForMessage({
      ...base,
      chatType: 'p2p',
      chatId: 'oc_dm',
      messageId: 'replay-5678',
      text: 'hi',
      synthetic: true,
    })
    assert.deepEqual(target, { chatId: 'oc_dm' })
  })

  it('gives a framework wake (bg-result / reconcile) NO turn card', () => {
    const target = turnCardTargetForMessage({
      ...base,
      messageId: 'wake-1',
      replyAnchorMessageId: 'om_anchor',
      text: '<background-task-result/>',
      synthetic: true,
      frameworkText: true,
    })
    assert.equal(target, null, 'framework wakes fold into the task card, not a fresh turn card')
  })

  it('gives a crash resume NO turn card', () => {
    const target = turnCardTargetForMessage({
      ...base,
      messageId: 'resume-1',
      text: '',
      synthetic: true,
      resumeExisting: true,
    })
    assert.equal(target, null, 'a crash resume continues existing work, it is not a fresh user turn')
  })

  it('carries threadId through for a topic-group turn', () => {
    const target = turnCardTargetForMessage({
      ...base,
      messageId: 'om_real',
      threadId: 'omt_topic',
      text: 'hello',
    })
    assert.deepEqual(target, {
      chatId: 'oc_group',
      threadId: 'omt_topic',
      replyAnchorMessageId: 'om_real',
    })
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

  it('does not prefix a framework synthetic turn (bg-result wake) with the sender name', async () => {
    // A bg-result / taskrun wake is framework-authored block text, not user
    // speech. Labeling it `[senderName]` reads to the model as "the user
    // pasted this block". The in-flight interjection path already renders
    // bg-results as raw block text; the synthetic-turn path must match.
    const strategy = installFakeStrategy('feishu')
    strategy.resolveSenderName = async () => '张三'
    const block =
      '<background-task-result label="x" outcome="success" dispatchId="d">done</background-task-result>'
    const text = await formatChannelUserText(
      strategy,
      {
        channel: 'feishu',
        eventId: 'evt',
        chatId: 'oc_group',
        senderOpenId: 'ou_alice',
        chatType: 'group',
        messageId: 'om',
        text: block,
        synthetic: true,
        frameworkText: true,
      },
      null,
    )

    assert.equal(text, block)
    assert.ok(!text.startsWith('['), 'a framework synthetic turn must not carry a [senderName] prefix')
  })

  it('still prefixes a synthetic group turn that is NOT framework text (post-approval replay)', async () => {
    // The post-approval replay synthetic carries the user's real words and
    // MUST keep the sender prefix — the frameworkText guard must not
    // over-suppress synthetic turns that genuinely represent the user.
    const strategy = installFakeStrategy('feishu')
    strategy.resolveSenderName = async () => '张三'
    const text = await formatChannelUserText(
      strategy,
      {
        channel: 'feishu',
        eventId: 'evt',
        chatId: 'oc_group',
        senderOpenId: 'ou_alice',
        chatType: 'group',
        messageId: 'om',
        text: 'my earlier question',
        synthetic: true,
      },
      null,
    )

    assert.equal(text, '[张三] my earlier question')
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

  it('falls back to (no text) for an empty DM message so no empty content block reaches the wire', async () => {
    // Regression: a DM whose only content was the bot @-mention (stripped
    // before this function runs) arrives here with empty `text` and gets no
    // `[sender]` prefix (DMs don't). The pre-fix branch returned '', which
    // became a {type:'text', text:''} block and a provider 400 on empty
    // content. The guard must yield a non-empty, non-whitespace string.
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
        text: '',
      },
      null,
    )

    assert.equal(text, '(no text)')
    assert.ok(text.trim().length > 0, 'empty inbound must not produce empty model-facing text')
  })

  it('keeps the group sender prefix when the body is empty (no (no text) fallback)', async () => {
    // The empty-mention group path relies on the `[sender] ` prefix making the
    // text non-empty, so the (no text) guard must NOT fire for groups.
    const strategy = installFakeStrategy('feishu')
    strategy.resolveSenderName = async () => '张三'
    const text = await formatChannelUserText(
      strategy,
      {
        channel: 'feishu',
        eventId: 'evt',
        chatId: 'oc_group',
        senderOpenId: 'ou_alice',
        chatType: 'group',
        messageId: 'om',
        text: '',
      },
      null,
    )

    assert.equal(text, '[张三] ')
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

  it('renders the application card when only a co-admin has a feishu binding (multi-admin)', async () => {
    // 2026-07-02 review §3.9: the gate read the singular
    // getAdminFeishuOpenId() — admins[0] only — while PairingCardCoordinator
    // fans review cards out to ALL Feishu-bound admins. A terminal-only
    // primary admin therefore forced the text fallback even though a
    // Feishu-bound co-admin could receive and act on the card.
    await createUser('admin')
    const { setAdmin, addAdmin } = await import('../identity/store.js')
    await setAdmin('admin')
    // Primary admin intentionally has NO feishu binding (terminal-only).
    await createUser('coadmin')
    await addLink('coadmin', 'feishu:ou_coadmin')
    await addAdmin('coadmin')

    const harness = makePairingStrategy()
    const runner = new ChannelRunner(harness.strategy)
    await runner.handleMessage(makeFakeFeishuMessage({ sender: 'ou_user', text: 'hello' }))

    assert.equal(harness.appCalls.length, 1, 'card path is live via the co-admin binding')
    assert.equal(harness.appCalls[0].applicantOpenId, 'ou_user')
    assert.equal(harness.notices.length, 0, 'no text fallback when a co-admin can receive the card')
    assert.equal(harness.dmNotices.length, 0, 'no bootstrap DM notice — the card is the applicant surface')
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

  it('bootstrap fallback stashes threadId + messageId for topic-group replay routing', async () => {
    // A topic-group @ carries threadId; without stashing it the replay
    // session drops the thread segment (transcript split from the user's
    // future in-topic messages) and every outbound in the replay turn
    // goes through im.message.create, opening a NEW topic per message
    // (2026-06-10 dogfood). The real messageId is stashed alongside as
    // the reply anchor — im.message.reply against it is the only send
    // that lands in the original topic.
    await createUser('admin')
    const { setAdmin } = await import('../identity/store.js')
    await setAdmin('admin')

    const harness = makePairingStrategy()
    const runner = new ChannelRunner(harness.strategy)
    await runner.handleMessage(
      makeFakeFeishuMessage({
        sender: 'ou_user',
        text: '帮我分析这篇论文',
        chatId: 'oc_topic_group',
        chatType: 'group',
        threadId: 'omt_thread_1',
      }),
    )

    const { listPending } = await import('../identity/pairing.js')
    const pending = await listPending()
    assert.equal(pending.length, 1, 'bootstrap fallback created the pending entry')
    assert.equal(pending[0].lastApplicantThreadId, 'omt_thread_1', 'origin threadId stashed')
    assert.equal(pending[0].lastApplicantMessageId, 'msg-ou_user', 'origin messageId stashed as reply anchor')

    // A later DM from the same pending applicant re-routes the stash:
    // threadId must CLEAR (the latest inbound is not in a topic) so the
    // replay does not chase a topic the user has left.
    const { updatePendingApplicantText } = await import('../identity/pairing.js')
    await updatePendingApplicantText(
      'feishu:ou_user',
      'follow-up in dm',
      'oc_dm_chat',
      'p2p',
      undefined,
      'om_dm_msg',
    )
    const updated = await listPending()
    assert.equal(updated[0].lastApplicantThreadId, undefined, 'stale threadId cleared on non-topic inbound')
    assert.equal(updated[0].lastApplicantMessageId, 'om_dm_msg', 'anchor follows the latest inbound')
  })

  it('falls back to in-chat notice when sendNoticeToOpenId hook is absent (legacy strategy)', async () => {
    // Channels without a "send to specific user without an inbound" surface
    // (or future test stubs that omit the hook) keep an in-chat response so
    // the applicant is never silently ignored — but the pairing-code
    // payload only goes in-chat for DM origins. Group/unknown origins get
    // the sanitized dmPushFailed line (2026-06-10 topic-group leak).
    await createUser('admin')
    const { setAdmin } = await import('../identity/store.js')
    await setAdmin('admin')

    const harness = makePairingStrategy({ hasNoticeToOpenIdHook: false })
    const runner = new ChannelRunner(harness.strategy)
    await runner.handleMessage(
      makeFakeFeishuMessage({ sender: 'ou_user', text: 'hello', chatType: 'p2p' }),
    )

    assert.equal(harness.dmNotices.length, 0)
    assert.equal(harness.notices.length, 1, 'in-chat fallback when strategy lacks DM hook')
    assert.match(harness.notices[0].text, /配对码|approve/)
  })

  it('in-chat fallback from a group origin sanitizes the pairing notice', async () => {
    // Same no-DM-hook degradation as above, but the applicant @-ed the bot
    // in a group: the in-chat fallback must not echo the pairing code to
    // every group member. The group sees only the dmPushFailed line.
    await createUser('admin')
    const { setAdmin } = await import('../identity/store.js')
    await setAdmin('admin')

    const harness = makePairingStrategy({ hasNoticeToOpenIdHook: false })
    const runner = new ChannelRunner(harness.strategy)
    await runner.handleMessage(
      makeFakeFeishuMessage({ sender: 'ou_user', text: 'hello', chatType: 'group' }),
    )

    assert.equal(harness.dmNotices.length, 0)
    assert.equal(harness.notices.length, 1, 'still responds in-chat')
    assert.doesNotMatch(harness.notices[0].text, /配对码/, 'pairing code never echoes into the group')
    assert.match(harness.notices[0].text, /无法向你发送私聊消息/)
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

  it('surfaces a soft withdrawal note when an already-drained interjection is recalled', async () => {
    const strategy = installFakeStrategy('feishu')
    const runner = new ChannelRunner(strategy)
    const sessionId = 'feishu:dm:oc_recall_drained'
    channelInterjectionQueue.markInFlight(sessionId)
    channelInterjectionQueue.push(sessionId, {
      messageId: 'om_drained',
      senderOpenId: 'ou_alice',
      text: 'also check the logs',
      arrivedAt: Date.now(),
    })
    channelInterjectionQueue.drain(sessionId) // the model has now seen it
    try {
      await runner.handleRecall({ messageId: 'om_drained', chatId: 'oc_recall_drained' })
      const queued = channelInterjectionQueue.drain(sessionId)
      assert.equal(queued.length, 1, 'a withdrawal note is queued for the next tool boundary')
      assert.match(queued[0]!.text, /RECALLED/)
      assert.equal(queued[0]!.synthetic, true)
      assert.equal(strategy.chatNotices.length, 0, 'soft path posts no user-facing notice')
    } finally {
      channelInterjectionQueue.unmarkInFlight(sessionId)
    }
  })

  it('surfaces a recalled-root signal to main and does NOT hard-abort the opener turn', async () => {
    await createUser('alice')
    await addLink('alice', 'feishu:ou_alice')
    const strategy = installFakeStrategy('feishu')
    const runner = new ChannelRunner(strategy)
    const sessionId = 'feishu:dm:oc_recall_root'
    const run = await createRootTaskRun('alice', sessionId, { objective: 'long horizon task' })
    recallRootIndex.register('om_kickoff', 'alice', sessionId, run.id)
    // Same message also opened the still-running turn (opener + abort
    // controller installed). Root precedence must win: soft surface, no abort.
    channelInterjectionQueue.markInFlight(sessionId, 'om_kickoff')
    const controller = new AbortController()
    setAbortControllerForSession(sessionId, controller)
    try {
      await runner.handleRecall({ messageId: 'om_kickoff', chatId: 'oc_recall_root' })
      assert.equal(controller.signal.aborted, false, 'root precedence: turn is NOT hard-aborted')
      assert.equal(strategy.chatNotices.length, 0, 'no interrupted notice on the soft path')
      const queued = channelInterjectionQueue.drain(sessionId)
      assert.equal(queued.length, 1, 'kickoff-withdrawn block surfaced to main')
      assert.match(queued[0]!.text, /recalled-task-kickoff/)
    } finally {
      channelInterjectionQueue.unmarkInFlight(sessionId)
      recallRootIndex.clear()
    }
  })

  it('falls through to the turn-level abort when the recalled root is already terminal', async () => {
    await createUser('alice')
    await addLink('alice', 'feishu:ou_alice')
    const strategy = installFakeStrategy('feishu')
    const runner = new ChannelRunner(strategy)
    const sessionId = 'feishu:dm:oc_recall_terminal'
    // Register an index entry pointing at a runId that has no live TaskRun on
    // disk — surfaceRecalledRootsToMain finds nothing live and returns false.
    recallRootIndex.register('om_kickoff2', 'alice', sessionId, 'tr_does_not_exist')
    channelInterjectionQueue.markInFlight(sessionId, 'om_kickoff2')
    const controller = new AbortController()
    setAbortControllerForSession(sessionId, controller)
    try {
      await runner.handleRecall({ messageId: 'om_kickoff2', chatId: 'oc_recall_terminal' })
      assert.equal(controller.signal.aborted, true, 'no live root → opener turn is aborted')
      assert.equal(strategy.chatNotices.length, 1, 'interrupted notice posted on the hard path')
    } finally {
      channelInterjectionQueue.unmarkInFlight(sessionId)
      recallRootIndex.clear()
    }
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

describe('ChannelRunner model resolution (config default vs frozen meta)', () => {
  // Regression for the model-meta-unfreeze fix: editing config.defaultModel +
  // restarting must reach an existing session. Pre-fix, runner.handleMessage
  // passed `model: meta?.model` into resetSessionContext, so a session whose
  // meta.json froze an older model (e.g. created when defaultModel was a
  // different model) kept streaming under that frozen model while `/model`
  // reported the freshly-synced config.defaultModel: a display-vs-actual
  // split. The model is now re-derived every turn as
  // `prefs.model ?? config.defaultModel`, so a config edit takes effect and an
  // explicit `/model` preference still wins.
  const NO_MEMORY = 'LIGHTCLAW_NO_MEMORY'
  let savedNoMemory: string | undefined

  function writeLocalTwoModelConfig(): void {
    writeFileSync(
      path.join(tmpHome, 'config.json'),
      JSON.stringify({
        endpoints: { fake: { apiKey: 'sk-fake' } },
        models: {
          fake: { endpoint: 'fake', schema: 'anthropic', upstreamModel: 'claude-fake' },
          other: { endpoint: 'fake', schema: 'anthropic', upstreamModel: 'claude-other' },
        },
        defaultModel: 'fake',
        autoMemory: false,
        hooksEnabled: false,
        mcpEnabled: false,
        // local backend needs no docker/cluster control plane; admin-only, so
        // the test user is set as admin below.
        runtime: { backend: 'local' },
      }),
    )
  }

  // Drive one DM turn to completion and return the model id the turn actually
  // streamed under (the `model` query() passes to streamChat and the provider).
  // The fake stream ends the turn immediately, so no tool calls / network run.
  // LIGHTCLAW_NO_MEMORY=1 (set in beforeEach) suppresses the recall selector so
  // the main turn is the only streamChat call.
  async function modelUsedForTurn(sessionId: string): Promise<string | undefined> {
    let capturedModel: string | undefined
    setStreamChatForTest((async function* (args: { model?: string }): AsyncGenerator<StreamEvent> {
      if (capturedModel === undefined) capturedModel = args.model
      yield {
        type: 'stop',
        stopReason: 'end_turn',
        usage: { input_tokens: 8, output_tokens: 4 },
        content: [{ type: 'text', text: 'ok' }],
      }
    }) as unknown as Parameters<typeof setStreamChatForTest>[0])

    const runner = new ChannelRunner(installFakeStrategy('feishu'))
    await runner.handleMessage(
      makeFakeFeishuMessage({
        sender: 'ou_alice',
        text: 'hello there',
        sessionId,
        chatType: 'p2p',
        chatId: sessionId,
      }),
    )
    return capturedModel
  }

  beforeEach(() => {
    savedNoMemory = process.env[NO_MEMORY]
    process.env[NO_MEMORY] = '1'
    writeLocalTwoModelConfig()
  })

  afterEach(() => {
    setStreamChatForTest(null)
    if (savedNoMemory === undefined) {
      delete process.env[NO_MEMORY]
    } else {
      process.env[NO_MEMORY] = savedNoMemory
    }
  })

  it('ignores a frozen meta.model and streams under config.defaultModel', async () => {
    await createUser('alice')
    await addLink('alice', 'feishu:ou_alice')
    await setAdmin('alice')

    const sessionId = 'feishu:dm:oc_modelfrozen'
    // A session created back when defaultModel was a different model: 'other'
    // is frozen in meta.json. Editing config.defaultModel to 'fake' + restart
    // does NOT rewrite this meta.
    await saveMeta(sessionId, {
      sessionId,
      model: 'other',
      cwd: '/tmp',
      createdAt: 1,
      lastActiveAt: 1,
      messageCount: 0,
      compactionCount: 0,
      userId: 'alice',
    })

    const used = await modelUsedForTurn(sessionId)
    // Pre-fix this was 'other' (meta.model flowed into appConfig.defaultModel).
    assert.equal(used, 'fake')
  })

  it('lets an explicit /model preference win over the config default', async () => {
    await createUser('alice')
    await addLink('alice', 'feishu:ou_alice')
    await setAdmin('alice')
    // `/model other` persists this preference; it must outrank config.defaultModel.
    setIdentityPreference({ canonicalUser: 'alice', key: 'model', value: 'other' })

    const used = await modelUsedForTurn('feishu:dm:oc_modelpref')
    assert.equal(used, 'other')
  })

  it('falls back to whole-message sendReply when streaming reply throws', async () => {
    await createUser('alice')
    await addLink('alice', 'feishu:ou_alice')
    await setAdmin('alice')
    const strategy = installFakeStrategy('feishu')
    strategy.sendStreamingReply = async () => {
      throw new Error('cardkit down')
    }

    await runSingleTextTurn(new ChannelRunner(strategy), 'feishu:dm:oc_stream_fallback')

    assert.deepEqual(strategy.replies, [
      { messageId: 'msg-feishu:dm:oc_stream_fallback', text: 'ok' },
    ])
  })

  it('does not fall back to whole-message sendReply when streaming reply was aborted', async () => {
    await createUser('alice')
    await addLink('alice', 'feishu:ou_alice')
    await setAdmin('alice')
    const strategy = installFakeStrategy('feishu')
    let sawSignal = false
    strategy.sendStreamingReply = async (_message, _text, options) => {
      sawSignal = options?.signal instanceof AbortSignal
      return { aborted: true }
    }

    await runSingleTextTurn(new ChannelRunner(strategy), 'feishu:dm:oc_stream_abort')

    assert.equal(sawSignal, true)
    assert.deepEqual(strategy.replies, [])
  })

  // Regression (2026-06-19 dogfood): a follow-up that lands in the tail of a
  // prior turn gets an OnIt ack, then that prior turn's OWN final reply (which
  // answers the prior request, NOT the follow-up) wiped EVERY pending ack for
  // the session — the user saw their just-added emoji vanish and read it as
  // "stopped, no reply" even though a leftover-replay turn was still going to
  // answer them. clearPendingAcks is now scoped to the answered set, so an
  // unrelated reply leaves a not-yet-answered follow-up ack up.
  it('keeps a follow-up ack alive through an unrelated reply, retiring it only when its replay turn answers it', async () => {
    await createUser('alice')
    await addLink('alice', 'feishu:ou_alice')
    await setAdmin('alice')

    const chatId = 'feishu:dm:oc_followrace'
    const strategy = installFakeStrategy('feishu')
    strategy.resolveSessionId = () => chatId
    const cleared: string[] = []
    strategy.clearAck = async token => {
      cleared.push((token as { reactionId: string }).reactionId)
    }
    const runner = new ChannelRunner(strategy)

    // A follow-up that landed in the tail of a prior turn left an OnIt ack
    // pending on its OWN message ('msg-followup'); it was not drained by that
    // turn and will be answered later by a leftover-replay turn whose opener
    // IS that message.
    ;(runner as unknown as {
      pendingAckTokens: Map<string, { messageId: string; token: unknown }[]>
    }).pendingAckTokens.set(chatId, [
      { messageId: 'msg-followup', token: { reactionId: 'rx-follow' } },
    ])

    // Turn A: the prior request's reply lands. It answers 'msg-opener', NOT the
    // follow-up — the follow-up ack must survive.
    setStreamChatForTest((async function* (): AsyncGenerator<StreamEvent> {
      yield {
        type: 'stop',
        stopReason: 'end_turn',
        usage: { input_tokens: 8, output_tokens: 4 },
        content: [{ type: 'text', text: 'done with the original task' }],
      }
    }) as unknown as Parameters<typeof setStreamChatForTest>[0])
    await runner.handleMessage(
      makeFakeFeishuMessage({
        sender: 'ou_alice',
        text: 'do the original task',
        sessionId: 'opener',
        chatId,
        chatType: 'p2p',
      }),
    )
    assert.deepEqual(
      cleared,
      [],
      'an unrelated reply must NOT retire the follow-up OnIt (pre-fix it cleared every session ack)',
    )

    // Turn B: the leftover-replay turn whose opener IS the follow-up message —
    // this reply answers the follow-up, so its OnIt is finally retired.
    setStreamChatForTest((async function* (): AsyncGenerator<StreamEvent> {
      yield {
        type: 'stop',
        stopReason: 'end_turn',
        usage: { input_tokens: 8, output_tokens: 4 },
        content: [{ type: 'text', text: 'here is your weather' }],
      }
    }) as unknown as Parameters<typeof setStreamChatForTest>[0])
    await runner.handleMessage(
      makeFakeFeishuMessage({
        sender: 'ou_alice',
        text: 'what is the weather',
        sessionId: 'followup',
        chatId,
        chatType: 'p2p',
      }),
    )
    assert.deepEqual(
      cleared,
      ['rx-follow'],
      'the replay turn that answers the follow-up retires its OnIt',
    )
  })

  async function runSingleTextTurn(runner: ChannelRunner, sessionId: string): Promise<void> {
    setStreamChatForTest((async function* (): AsyncGenerator<StreamEvent> {
      yield {
        type: 'stop',
        stopReason: 'end_turn',
        usage: { input_tokens: 8, output_tokens: 4 },
        content: [{ type: 'text', text: 'ok' }],
      }
    }) as unknown as Parameters<typeof setStreamChatForTest>[0])
    await runner.handleMessage(
      makeFakeFeishuMessage({
        sender: 'ou_alice',
        text: 'hello there',
        sessionId,
        chatType: 'p2p',
        chatId: sessionId,
      }),
    )
  }
})

describe('buildLeftoverReplayMessage reply anchor (topic-group drop fix)', () => {
  // Regression (2026-06-12 dogfood): a bg-result rescued into a synthetic
  // replay turn had no reply anchor, so in topic groups its entire output
  // hit the create path and was refused/dropped — the final "test passed"
  // notification never reached the user. The just-ended turn's own genuine
  // inbound message is the anchor.
  it('anchors a bg-result replay to the original genuine inbound message', () => {
    const original = makeFakeFeishuMessage({
      sender: 'ou_alice',
      text: 'original turn',
      threadId: 'omt_topic',
    })
    const entry: InterjectionEntry = {
      messageId: 'bg-x-1',
      senderOpenId: 'ou_alice',
      text: '<background-task-result>...</background-task-result>',
      arrivedAt: 1,
      source: 'background-task',
    }
    const replay = buildLeftoverReplayMessage(original, entry)
    assert.equal(replay.synthetic, true)
    assert.equal(replay.replyAnchorMessageId, original.messageId)
  })

  it('propagates the anchor when the original opener was itself synthetic', () => {
    const original: NormalizedChannelMessage = {
      ...makeFakeFeishuMessage({ sender: 'ou_alice', text: 'wake opener' }),
      synthetic: true,
      replyAnchorMessageId: 'om_recorded_anchor',
    }
    const entry: InterjectionEntry = {
      messageId: 'bg-x-2',
      senderOpenId: 'ou_alice',
      text: '<background-task-result>...</background-task-result>',
      arrivedAt: 1,
      source: 'background-task',
    }
    const replay = buildLeftoverReplayMessage(original, entry)
    assert.equal(replay.replyAnchorMessageId, 'om_recorded_anchor')
  })

  it('leaves real-user leftover replays unanchored (they reply off their own real messageId)', () => {
    const original = makeFakeFeishuMessage({ sender: 'ou_alice', text: 'original turn' })
    const entry: InterjectionEntry = {
      messageId: 'om_realuser456',
      senderOpenId: 'ou_bob',
      text: 'mid-flight follow-up',
      arrivedAt: 1,
      source: 'user',
    }
    const replay = buildLeftoverReplayMessage(original, entry)
    assert.equal(replay.replyAnchorMessageId, undefined)
  })
})

describe('withFinalReplyMention (PR25 group ping)', () => {
  it('prefixes a lark_md mention for group finals and leaves DMs/synthetics alone', () => {
    const group = makeFakeFeishuMessage({ sender: 'ou_alice', text: 'q', chatType: 'group' })
    assert.equal(
      withFinalReplyMention(group, '答案在此'),
      '<at id=ou_alice></at> 答案在此',
    )
    const dm = makeFakeFeishuMessage({ sender: 'ou_alice', text: 'q', chatType: 'p2p' })
    assert.equal(withFinalReplyMention(dm, '答案在此'), '答案在此')
    const synthetic: NormalizedChannelMessage = {
      ...makeFakeFeishuMessage({ sender: 'ou_alice', text: 'q', chatType: 'group' }),
      synthetic: true,
    }
    assert.equal(withFinalReplyMention(synthetic, '答案在此'), '答案在此')
    const unknownType = makeFakeFeishuMessage({ sender: 'ou_alice', text: 'q' })
    assert.equal(withFinalReplyMention(unknownType, '答案在此'), '答案在此')
  })

  it('mentionSynthetic opts a standing-service report back into the group ping', () => {
    const synthetic: NormalizedChannelMessage = {
      ...makeFakeFeishuMessage({ sender: 'ou_alice', text: 'wake', chatType: 'group' }),
      synthetic: true,
    }
    assert.equal(
      withFinalReplyMention(synthetic, '每日报告', { mentionSynthetic: true }),
      '<at id=ou_alice></at> 每日报告',
    )
    // DM standing reports stay bare — the DM push itself notifies.
    const dm: NormalizedChannelMessage = {
      ...makeFakeFeishuMessage({ sender: 'ou_alice', text: 'wake', chatType: 'p2p' }),
      synthetic: true,
    }
    assert.equal(withFinalReplyMention(dm, '每日报告', { mentionSynthetic: true }), '每日报告')
  })
})

describe('ChannelRunner framework-wake in-flight guard', () => {
  // Regression: a framework-authored synthetic wake (frameworkText, e.g. a
  // <background-task-result> block) can reach handleMessage while a turn is
  // already in flight. wakeOrInterject checks hasInflightFor and only
  // synthesizes this handleMessage call when the session looked idle, but a
  // genuine inbound can win the race and markInFlight in the window between
  // that check and this body. Such a wake must be re-queued in the framework
  // block shape (source:'background-task', synthetic:true) — NOT swept into
  // the user-interjection branch, which would wrap the block in
  // <user-interjection>, queue it as a user entry (source undefined), and emit
  // a user-facing "记下了" ack for a block the user never sent.
  it('re-queues an in-flight framework wake as a background-task interjection, not a user interjection', async () => {
    await createUser('alice')
    await addLink('alice', 'feishu:ou_alice')

    const strategy = installFakeStrategy('feishu')
    const runner = new ChannelRunner(strategy)
    const mainSessionId = 'feishu-alice-main'
    strategy.resolveSessionId = () => mainSessionId

    channelInterjectionQueue.markInFlight(mainSessionId)

    const wake: NormalizedChannelMessage = {
      ...makeFakeFeishuMessage({
        sender: 'ou_alice',
        text: '<background-task-result>job done</background-task-result>',
        chatId: mainSessionId,
      }),
      synthetic: true,
      frameworkText: true,
      taskCardRoot: { owner: 'alice', rootRunId: 'run-1' },
    }
    try {
      await runner.handleMessage(wake)

      const drained = channelInterjectionQueue.drain(mainSessionId)
      assert.equal(drained.length, 1, 'the framework wake should be queued exactly once')
      const entry = drained[0]!
      assert.equal(
        entry.source,
        'background-task',
        'the wake must be queued as a framework block, not a user interjection (source undefined)',
      )
      assert.equal(entry.synthetic, true, 'the wake entry must be marked synthetic')
      assert.equal(
        entry.text,
        '<background-task-result>job done</background-task-result>',
        'the framework block text must be preserved verbatim',
      )
      assert.deepEqual(
        entry.taskCardRoot,
        { owner: 'alice', rootRunId: 'run-1' },
        'taskCardRoot must ride the re-queued entry',
      )
      assert.equal(
        strategy.replies.length,
        0,
        'a framework wake must not produce a user-facing ack reply',
      )
    } finally {
      channelInterjectionQueue.unmarkInFlight(mainSessionId)
    }
  })

  // A crash-resume synthetic (resumeExisting, empty text, no deliverable
  // block) that hits the same in-flight race carries nothing to enqueue — the
  // live turn already owns the loaded transcript — so it must be dropped, not
  // queued and not acked.
  it('drops an in-flight resumeExisting synthetic without queuing or acking', async () => {
    await createUser('bob')
    await addLink('bob', 'feishu:ou_bob')

    const strategy = installFakeStrategy('feishu')
    const runner = new ChannelRunner(strategy)
    const mainSessionId = 'feishu-bob-main'
    strategy.resolveSessionId = () => mainSessionId

    channelInterjectionQueue.markInFlight(mainSessionId)

    const resume: NormalizedChannelMessage = {
      ...makeFakeFeishuMessage({ sender: 'ou_bob', text: '', chatId: mainSessionId }),
      synthetic: true,
      resumeExisting: true,
    }
    try {
      await runner.handleMessage(resume)

      assert.equal(
        channelInterjectionQueue.size(mainSessionId),
        0,
        'a resumeExisting synthetic must not be queued',
      )
      assert.equal(strategy.replies.length, 0, 'a resumeExisting synthetic must not be acked')
    } finally {
      channelInterjectionQueue.unmarkInFlight(mainSessionId)
    }
  })
})
