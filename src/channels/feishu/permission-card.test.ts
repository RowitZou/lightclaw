import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { setLightclawHomeOverride } from '../../paths.js'
import {
  createSessionContext,
  runWithSessionContext,
  type SessionContext,
} from '../../session-context.js'
import type {
  PermissionAskInput,
  PermissionDecision,
} from '../../permission/types.js'
import type { NormalizedChannelMessage } from '../types.js'
import { FeishuPermissionCoordinator } from './permission-card.js'
import type { FeishuSender } from './sender.js'

class FakeSender {
  cardSends = 0
  dmCardSends = 0
  textSends = 0
  lastCard: Record<string, any> | null = null
  lastDmCard: Record<string, any> | null = null
  lastText: string | null = null
  cardShouldFail = false
  dmShouldFail = false

  async sendInteractiveCard(_msg: unknown, card: Record<string, any>): Promise<void> {
    this.cardSends += 1
    this.lastCard = card
    if (this.cardShouldFail) {
      throw new Error('card blocked')
    }
  }

  async sendInteractiveCardToOpenId(_openId: string, card: Record<string, any>): Promise<void> {
    this.dmCardSends += 1
    this.lastDmCard = card
    if (this.dmShouldFail) {
      throw new Error('blocked')
    }
  }

  async sendText(_msg: unknown, text: string): Promise<void> {
    this.textSends += 1
    this.lastText = text
  }
}

function fakeMessage(
  senderOpenId: string,
  chatId = 'chat-1',
  chatType = 'p2p',
): NormalizedChannelMessage {
  return {
    channel: 'feishu',
    eventId: `evt-${Math.random().toString(36).slice(2)}`,
    chatId,
    senderOpenId,
    chatType,
    messageId: `msg-${Math.random().toString(36).slice(2)}`,
    text: 'hi',
  }
}

function ask(
  toolName: string,
  ruleContent: string | undefined = undefined,
): PermissionAskInput {
  const command = ruleContent
    ? `${ruleContent.replace(/:\*$/, '')} arg`
    : 'cmd'
  return {
    toolName,
    riskLevel: 'execute',
    input: { command },
    inputPreview: ruleContent ? `Command: ${ruleContent}` : 'Command: cmd',
    mode: 'default',
    suggestedRules: ruleContent ? [{ toolName, ruleContent }] : [{ toolName }],
  }
}

describe('FeishuPermissionCoordinator queue + reevaluate', () => {
  let home: string
  let ctx: SessionContext

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'lightclaw-perm-coord-'))
    setLightclawHomeOverride(home)
    ctx = createSessionContext({
      cwd: home,
      model: 'fake-model',
      sessionsDir: path.join(home, 'sessions'),
      memoryDir: path.join(home, 'memory'),
      currentUserId: 'alice',
    })
  })

  afterEach(() => {
    setLightclawHomeOverride(undefined)
    rmSync(home, { recursive: true, force: true })
  })

  function inSession<T>(fn: () => Promise<T>): Promise<T> {
    return runWithSessionContext(ctx, fn)
  }

  it('queues concurrent asks per owner, renders only the head', () => inSession(async () => {
    const sender = new FakeSender()
    const coord = new FeishuPermissionCoordinator(sender as unknown as FeishuSender)
    const message = fakeMessage('alice-open-id')
    const approver = coord.createApprover({
      message,
      sessionId: 'sess-1',
      userId: 'alice',
    })

    const head = approver.ask(ask('Bash', 'curl:*'))
    const tail1 = approver.ask(ask('Bash', 'curl:*'))
    const tail2 = approver.ask(ask('Bash', 'curl:*'))
    // Let the queue settle (renderPending is fire-and-forget)
    await new Promise(r => setImmediate(r))
    assert.equal(sender.cardSends, 1, 'only the head renders a card')
    // Cleanup: deny all so promises resolve before the test exits
    await coord.handleCardAction({
      requestId: extractHeadId(coord),
      action: 'deny',
      operatorOpenId: 'alice-open-id',
    })
    // Now the next head renders; deny that too, and the third
    await new Promise(r => setImmediate(r))
    await coord.handleCardAction({
      requestId: extractHeadId(coord),
      action: 'deny',
      operatorOpenId: 'alice-open-id',
    })
    await new Promise(r => setImmediate(r))
    await coord.handleCardAction({
      requestId: extractHeadId(coord),
      action: 'deny',
      operatorOpenId: 'alice-open-id',
    })
    const decisions = await Promise.all([head, tail1, tail2])
    for (const d of decisions) {
      assert.equal(d.behavior, 'deny')
    }
  }))

  it('allow_rules sweeps tail same-kind requests without rendering more cards', () => inSession(async () => {
    const sender = new FakeSender()
    const coord = new FeishuPermissionCoordinator(sender as unknown as FeishuSender)
    const message = fakeMessage('alice-open-id')
    const approver = coord.createApprover({
      message,
      sessionId: 'sess-1',
      userId: 'alice',
    })

    const head: Promise<PermissionDecision> = approver.ask(ask('Bash', 'curl:*'))
    const tail1: Promise<PermissionDecision> = approver.ask(ask('Bash', 'curl:*'))
    const tail2: Promise<PermissionDecision> = approver.ask(ask('Bash', 'curl:*'))
    await new Promise(r => setImmediate(r))
    assert.equal(sender.cardSends, 1, 'one card for the head only')

    // User clicks allow_rules on the head: install Bash(curl:*) into identity
    // and sweep the tail.
    await coord.handleCardAction({
      requestId: extractHeadId(coord),
      action: 'allow_rules',
      operatorOpenId: 'alice-open-id',
    })

    const decisions = await Promise.all([head, tail1, tail2])
    assert.equal(decisions[0].behavior, 'allow', 'head allowed')
    assert.equal(decisions[1].behavior, 'allow', 'tail1 swept by new rule')
    assert.equal(decisions[2].behavior, 'allow', 'tail2 swept by new rule')
    assert.equal(
      sender.cardSends,
      2,
      'only the original approval card plus the follow-up notice were sent',
    )
  }))

  it('allow_rules does not sweep different-kind tail requests (still asked)', () => inSession(async () => {
    const sender = new FakeSender()
    const coord = new FeishuPermissionCoordinator(sender as unknown as FeishuSender)
    const message = fakeMessage('alice-open-id')
    const approver = coord.createApprover({
      message,
      sessionId: 'sess-1',
      userId: 'alice',
    })

    const headCurl = approver.ask(ask('Bash', 'curl:*'))
    const tailRm = approver.ask(ask('Bash', 'rm:*'))
    await new Promise(r => setImmediate(r))
    assert.equal(sender.cardSends, 1)

    await coord.handleCardAction({
      requestId: extractHeadId(coord),
      action: 'allow_rules',
      operatorOpenId: 'alice-open-id',
    })
    await new Promise(r => setImmediate(r))

    assert.equal((await headCurl).behavior, 'allow')
    assert.equal(sender.cardSends, 3, 'rm tail still gets its own card after the notice')

    // Cleanup: deny the rm tail
    await coord.handleCardAction({
      requestId: extractHeadId(coord),
      action: 'deny',
      operatorOpenId: 'alice-open-id',
    })
    assert.equal((await tailRm).behavior, 'deny')
  }))

  it('allow_rules persists to disk so a subsequent ask hits the new rule', () => inSession(async () => {
    const sender = new FakeSender()
    const coord = new FeishuPermissionCoordinator(sender as unknown as FeishuSender)
    const message = fakeMessage('alice-open-id')
    const approver = coord.createApprover({
      message,
      sessionId: 'sess-1',
      userId: 'alice',
    })

    const first = approver.ask(ask('Bash', 'curl:*'))
    await new Promise(r => setImmediate(r))
    await coord.handleCardAction({
      requestId: extractHeadId(coord),
      action: 'allow_rules',
      operatorOpenId: 'alice-open-id',
    })
    assert.equal((await first).behavior, 'allow')

    // Re-init state from disk (simulate next channel message / daemon
    // restart). Identity rules should be reloaded.
    const { loadIdentityRules } = await import('../../permission/storage.js')
    const reloaded = loadIdentityRules('alice')
    assert.equal(reloaded.length, 1)
    assert.equal(reloaded[0].behavior, 'allow')
    assert.equal(reloaded[0].value.toolName, 'Bash')
    assert.equal(reloaded[0].value.ruleContent, 'curl:*')
  }))

  it('high-risk pending: card has no middle button + applyAction degrades allow_rules to allow once + no rule persisted', () => inSession(async () => {
    const sender = new FakeSender()
    const coord = new FeishuPermissionCoordinator(sender as unknown as FeishuSender)
    const message = fakeMessage('alice-open-id')
    const approver = coord.createApprover({
      message,
      sessionId: 'sess-1',
      userId: 'alice',
    })

    // `cd /tmp && rm -rf foo` shape — chain contains rm → high-risk
    const headPromise = approver.ask({
      toolName: 'Bash',
      riskLevel: 'execute',
      input: { command: 'cd /tmp && rm -rf foo' },
      inputPreview: 'Command: cd /tmp && rm -rf foo',
      mode: 'default',
      suggestedRules: [
        { toolName: 'Bash', ruleContent: 'cd:*' },
        { toolName: 'Bash', ruleContent: 'rm:*' },
      ],
    })
    await new Promise(r => setImmediate(r))

    // Card payload must omit the middle "以后都允许" button.
    const card = sender.lastCard
    assert.ok(card, 'card was sent')
    const action = card!.elements.find((e: any) => e.tag === 'action')
    assert.ok(action, 'action row present')
    assert.equal(action.actions.length, 2, 'high-risk → 2 buttons only')
    assert.equal(action.actions[0].text.content, '本次允许')
    assert.equal(action.actions[1].text.content, '拒绝')
    assert.equal((card as any).header.template, 'red', 'header turns red for high-risk')

    // Stale-card click for "allow_rules" must downgrade, not persist.
    await coord.handleCardAction({
      requestId: extractHeadId(coord),
      action: 'allow_rules',
      operatorOpenId: 'alice-open-id',
    })
    const decision = await headPromise
    assert.equal(decision.behavior, 'allow', 'still allow (downgraded to once)')
    assert.equal('matchedRule' in decision, false, 'no matched rule (no install)')

    const { loadIdentityRules } = await import('../../permission/storage.js')
    assert.deepEqual(
      loadIdentityRules('alice'),
      [],
      'no identity rule persisted for high-risk grant',
    )
  }))

  it('high-risk via raw input only (suggestedRules empty fallback) still hides middle button', () => inSession(async () => {
    const sender = new FakeSender()
    const coord = new FeishuPermissionCoordinator(sender as unknown as FeishuSender)
    const message = fakeMessage('alice-open-id')
    const approver = coord.createApprover({
      message,
      sessionId: 'sess-1',
      userId: 'alice',
    })

    const head = approver.ask({
      toolName: 'Bash',
      riskLevel: 'execute',
      input: { command: 'sudo apt-get update' },
      inputPreview: 'Command: sudo apt-get update',
      mode: 'default',
      suggestedRules: [], // empty — exercises the raw-input fallback
    })
    await new Promise(r => setImmediate(r))

    const card = sender.lastCard
    const action = card!.elements.find((e: any) => e.tag === 'action')
    assert.equal(action.actions.length, 2, 'sudo via raw-input fallback also hides middle')

    // Cleanup: deny so promise resolves
    await coord.handleCardAction({
      requestId: extractHeadId(coord),
      action: 'deny',
      operatorOpenId: 'alice-open-id',
    })
    assert.equal((await head).behavior, 'deny')
  }))

  it('isolates queues per owner (different sender)', () => inSession(async () => {
    const sender = new FakeSender()
    const coord = new FeishuPermissionCoordinator(sender as unknown as FeishuSender)
    const aliceMsg = fakeMessage('alice-open-id', 'chat-1')
    const bobMsg = fakeMessage('bob-open-id', 'chat-1')
    const aliceApprover = coord.createApprover({
      message: aliceMsg,
      sessionId: 'sess-alice',
      userId: 'alice',
    })
    const bobApprover = coord.createApprover({
      message: bobMsg,
      sessionId: 'sess-bob',
      userId: 'bob',
    })

    const aliceP = aliceApprover.ask(ask('Bash', 'curl:*'))
    const bobP = bobApprover.ask(ask('Bash', 'curl:*'))
    await new Promise(r => setImmediate(r))
    assert.equal(sender.cardSends, 2, 'each owner gets its own head card')

    // Resolve both quickly so the test exits cleanly.
    await coord.handleCardAction({
      requestId: extractPendingForSession(coord, 'sess-alice'),
      action: 'deny',
      operatorOpenId: 'alice-open-id',
    })
    await coord.handleCardAction({
      requestId: extractPendingForSession(coord, 'sess-bob'),
      action: 'deny',
      operatorOpenId: 'bob-open-id',
    })
    const [aliceR, bobR] = await Promise.all([aliceP, bobP])
    assert.equal(aliceR.behavior, 'deny')
    assert.equal(bobR.behavior, 'deny')
  }))

  it('pushes group approval cards to the sender DM with originSessionId in button values', () => inSession(async () => {
    const sender = new FakeSender()
    const coord = new FeishuPermissionCoordinator(sender as unknown as FeishuSender)
    const message = fakeMessage('alice-open-id', 'chat-group', 'group')
    const approver = coord.createApprover({
      message,
      sessionId: 'feishu:group:chat-group:alice-open-id',
      userId: 'alice',
    })

    const pending = approver.ask(ask('Bash', 'curl:*'))
    await new Promise(r => setImmediate(r))

    assert.equal(sender.dmCardSends, 1)
    assert.equal(sender.cardSends, 0)
    const actionRow = sender.lastDmCard!.elements.find((e: any) => e.tag === 'action')
    assert.equal(
      actionRow.actions[0].value.originSessionId,
      'feishu:group:chat-group:alice-open-id',
    )

    await coord.handleCardAction({
      requestId: extractPendingForSession(coord, 'feishu:group:chat-group:alice-open-id'),
      action: 'deny',
      operatorOpenId: 'alice-open-id',
      originSessionId: 'feishu:group:chat-group:alice-open-id',
    })
    assert.equal((await pending).behavior, 'deny')
  }))

  it('falls back to in-chat group card when DM push fails', () => inSession(async () => {
    const sender = new FakeSender()
    sender.dmShouldFail = true
    const coord = new FeishuPermissionCoordinator(sender as unknown as FeishuSender)
    const approver = coord.createApprover({
      message: fakeMessage('alice-open-id', 'chat-group', 'group'),
      sessionId: 'feishu:group:chat-group:alice-open-id',
      userId: 'alice',
    })

    const pending = approver.ask(ask('Bash', 'curl:*'))
    await new Promise(r => setImmediate(r))

    assert.equal(sender.dmCardSends, 1)
    assert.equal(sender.cardSends, 1)

    await coord.handleCardAction({
      requestId: extractPendingForSession(coord, 'feishu:group:chat-group:alice-open-id'),
      action: 'deny',
      operatorOpenId: 'alice-open-id',
      originSessionId: 'feishu:group:chat-group:alice-open-id',
    })
    assert.equal((await pending).behavior, 'deny')
  }))

  it('keeps DM and group queues independent for the same sender', () => inSession(async () => {
    const sender = new FakeSender()
    const coord = new FeishuPermissionCoordinator(sender as unknown as FeishuSender)
    const dmApprover = coord.createApprover({
      message: fakeMessage('alice-open-id', 'chat-dm', 'p2p'),
      sessionId: 'feishu:dm:chat-dm',
      userId: 'alice',
    })
    const groupApprover = coord.createApprover({
      message: fakeMessage('alice-open-id', 'chat-group', 'group'),
      sessionId: 'feishu:group:chat-group:alice-open-id',
      userId: 'alice',
    })

    const dmPending = dmApprover.ask(ask('Bash', 'curl:*'))
    const groupPending = groupApprover.ask(ask('Bash', 'curl:*'))
    await new Promise(r => setImmediate(r))

    assert.equal(sender.cardSends, 1, 'DM card renders in-chat')
    assert.equal(sender.dmCardSends, 1, 'group card renders in sender DM')

    await coord.handleCardAction({
      requestId: extractPendingForSession(coord, 'feishu:dm:chat-dm'),
      action: 'deny',
      operatorOpenId: 'alice-open-id',
      originSessionId: 'feishu:dm:chat-dm',
    })
    await coord.handleCardAction({
      requestId: extractPendingForSession(coord, 'feishu:group:chat-group:alice-open-id'),
      action: 'deny',
      operatorOpenId: 'alice-open-id',
      originSessionId: 'feishu:group:chat-group:alice-open-id',
    })

    assert.equal((await dmPending).behavior, 'deny')
    assert.equal((await groupPending).behavior, 'deny')
  }))

  it('group ask: resolution notice is pushed to the sender DM, not back to the group', () => inSession(async () => {
    const sender = new FakeSender()
    const coord = new FeishuPermissionCoordinator(sender as unknown as FeishuSender)
    const approver = coord.createApprover({
      message: fakeMessage('alice-open-id', 'chat-group', 'group'),
      sessionId: 'feishu:group:chat-group:alice-open-id',
      userId: 'alice',
    })

    const pending = approver.ask(ask('Bash', 'curl:*'))
    await new Promise(r => setImmediate(r))
    // Approval card already pushed to DM (existing behavior, asserted by
    // earlier tests). dm=1, in-chat=0.
    assert.equal(sender.dmCardSends, 1, 'approval card pushed to DM')
    assert.equal(sender.cardSends, 0, 'approval card not sent to group')

    await coord.handleCardAction({
      requestId: extractPendingForSession(coord, 'feishu:group:chat-group:alice-open-id'),
      action: 'deny',
      operatorOpenId: 'alice-open-id',
      originSessionId: 'feishu:group:chat-group:alice-open-id',
    })
    assert.equal((await pending).behavior, 'deny')

    // The deny notice MUST follow the approval card to the DM. Sending it
    // back to the group would leak the resolution (and, for high-risk
    // downgrades, the command preview) to bystanders that the Phase 26
    // routing was meant to keep out of the loop entirely.
    assert.equal(sender.dmCardSends, 2, 'resolution notice pushed to DM')
    assert.equal(sender.cardSends, 0, 'resolution notice did NOT leak to the group')
  }))

  it('approval card delivery failure auto-denies and notifies user via plain text', () => inSession(async () => {
    const sender = new FakeSender()
    sender.cardShouldFail = true
    const coord = new FeishuPermissionCoordinator(sender as unknown as FeishuSender)
    const approver = coord.createApprover({
      message: fakeMessage('alice-open-id'),
      sessionId: 'sess-1',
      userId: 'alice',
    })

    const decisionP = approver.ask(ask('Bash', 'curl:*'))
    await new Promise(r => setImmediate(r))
    const decision = await decisionP

    assert.equal(sender.cardSends, 1, 'card send attempted once')
    assert.equal(sender.textSends, 1, 'plain text failure notice sent')
    assert.match(sender.lastText ?? '', /Bash/)
    assert.equal(decision.behavior, 'deny')
    assert.match(decision.reason ?? '', /card could not be delivered/i)
  }))

  it('tryAutoDenyForInterjection denies the visible head pending', () => inSession(async () => {
    const sender = new FakeSender()
    const coord = new FeishuPermissionCoordinator(sender as unknown as FeishuSender)
    const approver = coord.createApprover({
      message: fakeMessage('alice-open-id'),
      sessionId: 'sess-1',
      userId: 'alice',
    })

    const pending = approver.ask(ask('Bash', 'curl:*'))
    await new Promise(r => setImmediate(r))
    const denied = await coord.tryAutoDenyForInterjection('sess-1')
    const decision = await pending

    assert.equal(denied, true)
    assert.equal(decision.behavior, 'deny')
    assert.match(decision.reason ?? '', /interjected mid-flight/)
  }))

  it('tryAutoDenyForInterjection returns false for sessions with no pending head', () => inSession(async () => {
    const sender = new FakeSender()
    const coord = new FeishuPermissionCoordinator(sender as unknown as FeishuSender)

    assert.equal(await coord.tryAutoDenyForInterjection('missing-session'), false)
  }))

  // Mock timers so the 24h fallback fires deterministically inside a
  // subprocess test runner. Real-time setTimeout + node:test worker
  // subprocess interaction is finicky (the worker holds shutdown until
  // the loop drains, which conflates test completion with timer
  // lifecycle); mock timers tick.advance us through the path without
  // touching real time.
  it('expires pending after expiryMs, resolving as deny + pushing expired notice', t => inSession(async () => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const sender = new FakeSender()
    const coord = new FeishuPermissionCoordinator(
      sender as unknown as FeishuSender,
      { expiryMs: 24 * 60 * 60 * 1000 },
    )
    const approver = coord.createApprover({
      message: fakeMessage('alice-open-id'),
      sessionId: 'sess-1',
      userId: 'alice',
    })

    const decisionP = approver.ask(ask('Bash', 'curl:*'))
    await new Promise(r => process.nextTick(r))
    assert.equal(sender.cardSends, 1, 'approval card rendered')

    t.mock.timers.tick(24 * 60 * 60 * 1000)
    const decision = await decisionP
    assert.equal(decision.behavior, 'deny')
    assert.match(decision.reason ?? '', /(expired|失效)/i)
    // expirePending fires safeSendNotice → second sendInteractiveCard call.
    assert.equal(sender.cardSends, 2, 'expired notice card sent')
  }))

  it('normal resolution clears the expiry timer (no double-resolve)', t => inSession(async () => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const sender = new FakeSender()
    const coord = new FeishuPermissionCoordinator(
      sender as unknown as FeishuSender,
      { expiryMs: 24 * 60 * 60 * 1000 },
    )
    const approver = coord.createApprover({
      message: fakeMessage('alice-open-id'),
      sessionId: 'sess-1',
      userId: 'alice',
    })

    const decisionP = approver.ask(ask('Bash', 'curl:*'))
    await new Promise(r => process.nextTick(r))
    await coord.handleCardAction({
      requestId: extractHeadId(coord),
      action: 'allow',
      operatorOpenId: 'alice-open-id',
    })
    const decision = await decisionP
    assert.equal(decision.behavior, 'allow')

    // Tick past 24h. If the timer wasn't cleared in resolvePending, the
    // expirePending callback would fire and we'd see a 3rd card (the
    // "expired" notice). With proper clearTimeout, the tick is a no-op.
    t.mock.timers.tick(24 * 60 * 60 * 1000 + 1)
    assert.equal(sender.cardSends, 2, 'no expired card after normal resolve')
  }))

  it('aborted ask clears the expiry timer (no double-resolve)', t => inSession(async () => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const sender = new FakeSender()
    const coord = new FeishuPermissionCoordinator(
      sender as unknown as FeishuSender,
      { expiryMs: 24 * 60 * 60 * 1000 },
    )
    const approver = coord.createApprover({
      message: fakeMessage('alice-open-id'),
      sessionId: 'sess-1',
      userId: 'alice',
    })
    const controller = new AbortController()
    const askInput: PermissionAskInput = {
      ...ask('Bash', 'curl:*'),
      signal: controller.signal,
    }
    const decisionP = approver.ask(askInput)
    await new Promise(r => process.nextTick(r))
    controller.abort()
    const decision = await decisionP
    assert.equal(decision.behavior, 'deny')
    assert.match(decision.reason ?? '', /(abort|中断)/i)

    t.mock.timers.tick(24 * 60 * 60 * 1000 + 1)
    // No expired notice card after the abort path resolved + cleared timer.
    assert.equal(sender.cardSends, 1, 'no expired card after abort')
  }))
})

// ---- helpers ----

function extractHeadId(coord: FeishuPermissionCoordinator): string {
  // Reach into the private queue to grab the head id for the test. The
  // real card-action callback would receive this from the click payload.
  const map: Map<string, string[]> = (coord as any).queuesByOwner
  for (const queue of map.values()) {
    if (queue.length > 0) return queue[0]
  }
  throw new Error('extractHeadId: queue is empty')
}

function extractPendingForSession(
  coord: FeishuPermissionCoordinator,
  sessionId: string,
): string {
  const map: Map<string, string[]> = (coord as any).queuesByOwner
  const queue = map.get(sessionId)
  if (queue && queue.length > 0) {
    return queue[0]
  }
  throw new Error(`extractPendingForSession: no queue for ${sessionId}`)
}
