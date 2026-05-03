import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { setLightclawHomeOverride } from '../../paths.js'
import { initializeState } from '../../state.js'
import type {
  PermissionAskInput,
  PermissionDecision,
} from '../../permission/types.js'
import type { NormalizedChannelMessage } from '../types.js'
import { FeishuPermissionCoordinator } from './permission-card.js'
import type { FeishuSender } from './sender.js'

class FakeSender {
  cardSends = 0
  textSends = 0

  async sendInteractiveCard(): Promise<void> {
    this.cardSends += 1
  }

  async sendText(): Promise<void> {
    this.textSends += 1
  }
}

function fakeMessage(senderOpenId: string, chatId = 'chat-1'): NormalizedChannelMessage {
  return {
    channel: 'feishu',
    eventId: `evt-${Math.random().toString(36).slice(2)}`,
    chatId,
    senderOpenId,
    messageId: `msg-${Math.random().toString(36).slice(2)}`,
    text: 'hi',
  }
}

function ask(
  toolName: string,
  ruleContent: string | undefined = undefined,
): PermissionAskInput {
  return {
    toolName,
    riskLevel: 'execute',
    input: { command: ruleContent ? `${toolName.toLowerCase()} ${ruleContent} arg` : 'cmd' },
    inputPreview: ruleContent ? `Command: ${ruleContent}` : 'Command: cmd',
    mode: 'default',
    suggestedRules: ruleContent ? [{ toolName, ruleContent }] : [{ toolName }],
  }
}

describe('FeishuPermissionCoordinator queue + reevaluate', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'lightclaw-perm-coord-'))
    setLightclawHomeOverride(home)
    initializeState({
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

  it('queues concurrent asks per owner, renders only the head', async () => {
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
  })

  it('allow_rules sweeps tail same-kind requests without rendering more cards', async () => {
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
      1,
      'no extra cards rendered after the first; tail resolved silently',
    )
  })

  it('allow_rules does not sweep different-kind tail requests (still asked)', async () => {
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
    assert.equal(sender.cardSends, 2, 'rm tail still gets its own card')

    // Cleanup: deny the rm tail
    await coord.handleCardAction({
      requestId: extractHeadId(coord),
      action: 'deny',
      operatorOpenId: 'alice-open-id',
    })
    assert.equal((await tailRm).behavior, 'deny')
  })

  it('allow_rules persists to disk so a subsequent ask hits the new rule', async () => {
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
  })

  it('isolates queues per owner (different sender)', async () => {
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
      requestId: extractPendingForOwner(coord, 'alice-open-id'),
      action: 'deny',
      operatorOpenId: 'alice-open-id',
    })
    await coord.handleCardAction({
      requestId: extractPendingForOwner(coord, 'bob-open-id'),
      action: 'deny',
      operatorOpenId: 'bob-open-id',
    })
    const [aliceR, bobR] = await Promise.all([aliceP, bobP])
    assert.equal(aliceR.behavior, 'deny')
    assert.equal(bobR.behavior, 'deny')
  })
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

function extractPendingForOwner(
  coord: FeishuPermissionCoordinator,
  senderOpenId: string,
): string {
  const map: Map<string, string[]> = (coord as any).queuesByOwner
  for (const [key, queue] of map.entries()) {
    if (key.endsWith(`:${senderOpenId}`) && queue.length > 0) {
      return queue[0]
    }
  }
  throw new Error(`extractPendingForOwner: no queue for ${senderOpenId}`)
}
