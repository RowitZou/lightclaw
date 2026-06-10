import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { setLang } from '../../i18n/index.js'
import { setLightclawHomeOverride } from '../../paths.js'
import {
  addLink,
  createUser,
  setAdmin,
} from '../../identity/store.js'
import { listPending } from '../../identity/pairing.js'
import type { NormalizedChannelMessage } from '../types.js'
import type { FeishuSender } from './sender.js'
import {
  PairingCardCoordinator,
  type PairingCardAction,
} from './pairing-card.js'

let home: string

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'lightclaw-pairing-card-test-'))
  setLightclawHomeOverride(home)
  setLang('cn')
  writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({
      endpoints: { fake: { apiKey: 'sk-fake' } },
      models: { fake: { endpoint: 'fake', schema: 'anthropic', upstreamModel: 'claude-fake' } },
      defaultModel: 'fake',
      runtime: { backend: 'local' },
    }),
  )
})

afterEach(() => {
  setLightclawHomeOverride(undefined)
  rmSync(home, { recursive: true, force: true })
})

describe('PairingCardCoordinator', () => {
  it('renders application cards to applicant DM and cancels without creating pending entries', async () => {
    const sender = new FakeSender()
    const coord = new PairingCardCoordinator(sender as unknown as FeishuSender)
    await coord.sendApplicationCard(fakeMessage('ou_user'), {
      applicantOpenId: 'ou_user',
      applicantName: 'Alice',
    })

    // Application card pushed to applicant DM, never echoed in the original
    // chat (group privacy). Phase 25 → 28: was sender.sendInteractiveCard,
    // now sender.sendInteractiveCardToOpenId.
    assert.equal(sender.replyCards.length, 0, 'no in-chat echo')
    assert.equal(sender.openIdCards.length, 1)
    assert.equal(sender.openIdCards[0].openId, 'ou_user')

    const action = extractAction(cardForOpenId(sender, 'ou_user'), 'cancel')
    const response = await coord.handleCardAction(action)

    assert.match(JSON.stringify(response), /已取消申请/)
    assert.equal((await listPending()).length, 0)
  })

  it('confirm creates a pending code and pushes review card to admin', async () => {
    await createUser('admin')
    await setAdmin('admin')
    await addLink('admin', 'feishu:ou_admin')
    const sender = new FakeSender()
    const coord = new PairingCardCoordinator(sender as unknown as FeishuSender)
    await coord.sendApplicationCard(fakeMessage('ou_user'), {
      applicantOpenId: 'ou_user',
      applicantName: 'Alice',
      applicantEmail: 'alice@example.com',
      applicantUserId: 'abcd1234',
    })

    const response = await coord.handleCardAction(
      extractAction(cardForOpenId(sender, 'ou_user'), 'confirm'),
    )
    const pending = await listPending()

    assert.equal(pending.length, 1)
    assert.equal(pending[0].displayName, 'Alice')
    assert.equal(pending[0].email, 'alice@example.com')
    assert.equal(pending[0].userId, 'abcd1234')
    // openIdCards: [0] application card to applicant, [1] review card to admin.
    assert.equal(sender.openIdCards.length, 2)
    assert.equal(cardsForOpenId(sender, 'ou_admin').length, 1, 'review card to admin')
    assert.match(JSON.stringify(response), /等待管理员审批/)
  })

  it('approve links the applicant with the derived canonical and sends handover card', async () => {
    await createUser('admin')
    await setAdmin('admin')
    await addLink('admin', 'feishu:ou_admin')
    const sender = new FakeSender()
    const coord = new PairingCardCoordinator(sender as unknown as FeishuSender)
    await coord.sendApplicationCard(fakeMessage('ou_user'), {
      applicantOpenId: 'ou_user',
      applicantName: '邹易澄',
      applicantEmail: 'zouyicheng@pjlab.org.cn',
      applicantUserId: '62236ecd',
    })
    const confirm = extractAction(cardForOpenId(sender, 'ou_user'), 'confirm')
    await coord.handleCardAction(confirm)
    const reviewCard = cardForOpenId(sender, 'ou_admin')
    const approve = {
      ...extractAction(reviewCard, 'approve'),
      operatorOpenId: 'ou_admin',
    }

    const response = await coord.handleCardAction(approve)
    await new Promise(resolve => setImmediate(resolve))

    assert.match(JSON.stringify(response), /zouyicheng_62236ecd/)
    assert.equal(sender.openIdCards.at(-1)?.openId, 'ou_user')
  })

  it('reject consumes the pending code and pushes rejected card', async () => {
    await createUser('admin')
    await setAdmin('admin')
    await addLink('admin', 'feishu:ou_admin')
    const sender = new FakeSender()
    const coord = new PairingCardCoordinator(sender as unknown as FeishuSender)
    await coord.sendApplicationCard(fakeMessage('ou_user'), {
      applicantOpenId: 'ou_user',
      applicantName: 'Alice',
    })
    await coord.handleCardAction(extractAction(cardForOpenId(sender, 'ou_user'), 'confirm'))
    const reject = {
      ...extractAction(cardForOpenId(sender, 'ou_admin'), 'reject'),
      operatorOpenId: 'ou_admin',
    }

    const response = await coord.handleCardAction(reject)
    await new Promise(resolve => setImmediate(resolve))

    assert.match(JSON.stringify(response), /已拒绝/)
    assert.equal((await listPending()).length, 0)
    assert.equal(sender.openIdCards.at(-1)?.openId, 'ou_user')
  })

  it('rejects non-admin operators', async () => {
    await createUser('admin')
    await setAdmin('admin')
    await addLink('admin', 'feishu:ou_admin')
    const sender = new FakeSender()
    const coord = new PairingCardCoordinator(sender as unknown as FeishuSender)
    await coord.sendApplicationCard(fakeMessage('ou_user'), {
      applicantOpenId: 'ou_user',
      applicantName: 'Alice',
    })
    await coord.handleCardAction(extractAction(cardForOpenId(sender, 'ou_user'), 'confirm'))
    const approve = {
      ...extractAction(cardForOpenId(sender, 'ou_admin'), 'approve'),
      operatorOpenId: 'ou_not_admin',
    }

    const response = await coord.handleCardAction(approve)

    assert.match(JSON.stringify(response), /仅管理员可审批/)
    assert.equal((await listPending()).length, 1)
  })

  it('confirm without admin feishu binding still creates pending; no admin card pushed', async () => {
    // Bootstrap case: admin canonical exists but is not yet bound to any
    // Feishu open_id (e.g. fresh deployment, admin only on terminal). The
    // coordinator must still create the pending entry so admin can approve
    // via terminal /user approve <code>, and must NOT push a review card
    // to nowhere.
    await createUser('admin')
    await setAdmin('admin')
    const sender = new FakeSender()
    const coord = new PairingCardCoordinator(sender as unknown as FeishuSender)
    await coord.sendApplicationCard(fakeMessage('ou_user'), {
      applicantOpenId: 'ou_user',
      applicantName: 'Alice',
    })

    const response = await coord.handleCardAction(
      extractAction(cardForOpenId(sender, 'ou_user'), 'confirm'),
    )

    assert.equal((await listPending()).length, 1)
    // openIdCards still has the application card to applicant DM, but no
    // admin review card (admin has no feishu binding to receive it).
    assert.equal(cardsForOpenId(sender, 'ou_admin').length, 0, 'no admin card pushed when admin has no feishu binding')
    assert.match(JSON.stringify(response), /等待管理员审批/)
  })

  it('approve detects code already consumed elsewhere (terminal /user approve raced)', async () => {
    // Simulates the double-channel race: admin runs /user approve <code>
    // in terminal while the review card is still live. The card click then
    // finds approveCode() returns null because the entry was already
    // removed; coordinator must surface "已通过其他渠道处理" instead of
    // failing or double-creating identities.
    const { approveCode: approveCodeDirect } = await import('../../identity/pairing.js')
    await createUser('admin')
    await setAdmin('admin')
    await addLink('admin', 'feishu:ou_admin')
    const sender = new FakeSender()
    const coord = new PairingCardCoordinator(sender as unknown as FeishuSender)
    await coord.sendApplicationCard(fakeMessage('ou_user'), {
      applicantOpenId: 'ou_user',
      applicantName: 'Alice',
    })
    await coord.handleCardAction(extractAction(cardForOpenId(sender, 'ou_user'), 'confirm'))
    const reviewCard = cardForOpenId(sender, 'ou_admin')
    const approve = {
      ...extractAction(reviewCard, 'approve'),
      operatorOpenId: 'ou_admin',
    }
    // Race: terminal consumes the pending entry FIRST.
    const [{ code: stolenCode }] = await listPending()
    await approveCodeDirect(stolenCode)

    const response = await coord.handleCardAction(approve)

    assert.match(JSON.stringify(response), /已通过其他渠道处理/)
    // No follow-up handover card pushed to the applicant (we never minted
    // a canonical here). The application card to applicant DM and the
    // review card to admin DM both remain as the only sends.
    assert.equal(cardsForOpenId(sender, 'ou_admin').length, 1, 'only one admin review card')
    assert.equal(cardsForOpenId(sender, 'ou_user').length, 1, 'no extra applicant card')
  })

  it('double-tap confirm only pushes one admin review card', async () => {
    // Mobile double-tap fires two handlers for the same applicationToken
    // before either mutates byToken. CAS pending → submitting before the
    // first await must lock the second tap out so admin does not see two
    // identical review cards.
    await createUser('admin')
    await setAdmin('admin')
    await addLink('admin', 'feishu:ou_admin')
    const sender = new FakeSender()
    const coord = new PairingCardCoordinator(sender as unknown as FeishuSender)
    await coord.sendApplicationCard(fakeMessage('ou_user'), {
      applicantOpenId: 'ou_user',
      applicantName: 'Alice',
      applicantEmail: 'alice@example.com',
      applicantUserId: 'abcd1234',
    })
    const confirm = extractAction(cardForOpenId(sender, 'ou_user'), 'confirm')

    const [first, second] = await Promise.all([
      coord.handleCardAction(confirm),
      coord.handleCardAction(confirm),
    ])

    assert.equal(cardsForOpenId(sender, 'ou_admin').length, 1, 'only one admin review card pushed')
    // First fires the admin push + waiting card; second sees `submitting`
    // and renders the polite "still processing" body. Order isn't fixed
    // by Promise.all (microtask scheduling), so accept either ordering.
    const bodies = [JSON.stringify(first), JSON.stringify(second)]
    assert.ok(bodies.some(body => /等待管理员审批/.test(body)), 'one response is the waiting card')
    assert.ok(bodies.some(body => /正在提交申请/.test(body)), 'other response is the submitting toast')
    assert.equal((await listPending()).length, 1)
  })

  it('unknown application token returns expired card', async () => {
    const sender = new FakeSender()
    const coord = new PairingCardCoordinator(sender as unknown as FeishuSender)

    const response = await coord.handleCardAction({
      kind: 'lightclaw_pairing',
      action: 'confirm',
      applicationToken: 'not-a-real-token',
    })

    assert.match(JSON.stringify(response), /申请已过期/)
    assert.equal(sender.replyCards.length, 0)
    assert.equal(sender.openIdCards.length, 0)
  })

  it('group-context DM-push failure sends a sanitized notice in-chat, never the real card', async () => {
    // Privacy invariant: pairing cards target applicant DM. When the DM
    // push fails on a group/topic-origin message, the in-chat fallback
    // must NOT carry the real card — the application card has live
    // confirm/cancel buttons any group member could click, and the
    // waiting card carries the pairing code. The group gets a sanitized
    // no-button notice instead (2026-06-10 topic-group dogfood leak).
    const sender = new FlakyDmSender()
    const coord = new PairingCardCoordinator(sender as unknown as FeishuSender)
    const groupMsg: NormalizedChannelMessage = {
      ...fakeMessage('ou_user'),
      chatType: 'group',
      chatId: 'oc_group_xyz',
    }
    await coord.sendApplicationCard(groupMsg, {
      applicantOpenId: 'ou_user',
      applicantName: 'Alice',
    })

    assert.equal(sender.openIdAttempts.length, 1, 'attempted DM push first')
    assert.equal(sender.openIdAttempts[0], 'ou_user')
    assert.equal(sender.replyCards.length, 1, 'still responds in-chat after DM failure')
    const inChat = JSON.stringify(sender.replyCards[0])
    assert.doesNotMatch(inChat, /确认申请/, 'no clickable confirm button in group')
    assert.doesNotMatch(inChat, /lightclaw_pairing/, 'no actionable card payload in group')
    assert.match(inChat, /无法向你发送私聊消息/, 'sanitized dm-push-failed notice instead')

    // Same gate for the waiting card — its body carries the pairing code.
    await coord.sendWaitingCard(groupMsg, {
      code: '123456',
      applicantOpenId: 'ou_user',
      applicantName: 'Alice',
    })
    assert.equal(sender.replyCards.length, 2)
    const waitingInChat = JSON.stringify(sender.replyCards[1])
    assert.doesNotMatch(waitingInChat, /123456/, 'pairing code never lands in group')
  })

  it('dm-context DM-push failure still falls back to the real card in-chat', async () => {
    // DM origin: the inbound chat IS the applicant's DM, so resending the
    // real card there reaches the same (single-person) audience — no leak,
    // and the applicant keeps a clickable card.
    const sender = new FlakyDmSender()
    const coord = new PairingCardCoordinator(sender as unknown as FeishuSender)
    const dmMsg: NormalizedChannelMessage = {
      ...fakeMessage('ou_user'),
      chatType: 'p2p',
    }
    await coord.sendApplicationCard(dmMsg, {
      applicantOpenId: 'ou_user',
      applicantName: 'Alice',
    })

    assert.equal(sender.replyCards.length, 1)
    assert.match(JSON.stringify(sender.replyCards[0]), /确认申请/, 'real card retained in DM fallback')
  })

  it('confirm/cancel clicks from a non-applicant operator are rejected', async () => {
    // The card normally lives in the applicant's DM, but any card that ever
    // reached a group must not let a bystander submit or cancel someone
    // else's application.
    await createUser('admin')
    await setAdmin('admin')
    await addLink('admin', 'feishu:ou_admin')
    const sender = new FakeSender()
    const coord = new PairingCardCoordinator(sender as unknown as FeishuSender)
    await coord.sendApplicationCard(fakeMessage('ou_user'), {
      applicantOpenId: 'ou_user',
      applicantName: 'Alice',
    })
    const confirm = extractAction(cardForOpenId(sender, 'ou_user'), 'confirm')

    const bystander = await coord.handleCardAction({ ...confirm, operatorOpenId: 'ou_bystander' })
    assert.match(JSON.stringify(bystander), /只有申请人本人/)
    assert.equal((await listPending()).length, 0, 'bystander click creates no pending entry')

    const cancel = extractAction(cardForOpenId(sender, 'ou_user'), 'cancel')
    const bystanderCancel = await coord.handleCardAction({ ...cancel, operatorOpenId: 'ou_bystander' })
    assert.match(JSON.stringify(bystanderCancel), /只有申请人本人/)

    // The applicant's own click still works.
    const own = await coord.handleCardAction({ ...confirm, operatorOpenId: 'ou_user' })
    assert.match(JSON.stringify(own), /等待管理员审批/)
    assert.equal((await listPending()).length, 1)
  })

  it('evicts in-memory token state after the configured TTL elapses', async () => {
    // Without eviction, byToken would grow forever as cancelled / resolved
    // entries accumulate over the daemon's uptime. Evict after a short TTL
    // (10ms here) so a click on an evicted token falls into the !current
    // expired branch the same way an unknown token does. Use a small
    // numeric TTL via the coordinator's options injector rather than node
    // mock.timers — keeps the test free of global timer interception that
    // could affect other suites running in parallel.
    const sender = new FakeSender()
    const coord = new PairingCardCoordinator(
      sender as unknown as FeishuSender,
      { evictionTtlMs: 10 },
    )
    await coord.sendApplicationCard(fakeMessage('ou_user'), {
      applicantOpenId: 'ou_user',
      applicantName: 'Alice',
    })
    const cancel = extractAction(cardForOpenId(sender, 'ou_user'), 'cancel')
    await coord.handleCardAction(cancel)

    await new Promise(resolve => setTimeout(resolve, 30))

    // After the TTL fires, the cancelled state has been evicted from
    // byToken. A re-click on the same token now hits the expired branch
    // (the resolved card sender already saw remains visible to the user
    // — we are testing internal map cleanup, not card UX).
    const response = await coord.handleCardAction(cancel)
    assert.match(JSON.stringify(response), /申请已过期/)
  })
})

class FakeSender {
  replyCards: Record<string, unknown>[] = []
  openIdCards: Array<{ openId: string; card: Record<string, unknown> }> = []

  async sendInteractiveCard(_message: unknown, card: Record<string, unknown>): Promise<void> {
    this.replyCards.push(card)
  }

  async sendInteractiveCardToOpenId(openId: string, card: Record<string, unknown>): Promise<void> {
    this.openIdCards.push({ openId, card })
  }
}

class FlakyDmSender {
  replyCards: Record<string, unknown>[] = []
  openIdAttempts: string[] = []

  async sendInteractiveCard(_message: unknown, card: Record<string, unknown>): Promise<void> {
    this.replyCards.push(card)
  }

  async sendInteractiveCardToOpenId(openId: string, _card: Record<string, unknown>): Promise<void> {
    this.openIdAttempts.push(openId)
    throw new Error('simulated DM push failure (recipient unreachable)')
  }
}

function fakeMessage(senderOpenId: string): NormalizedChannelMessage {
  return {
    channel: 'feishu',
    eventId: `evt-${senderOpenId}`,
    chatId: 'chat-1',
    senderOpenId,
    senderKey: `feishu:${senderOpenId}`,
    messageId: `msg-${senderOpenId}`,
    text: 'hello',
  }
}

function cardForOpenId(
  sender: { openIdCards: Array<{ openId: string; card: Record<string, unknown> }> },
  openId: string,
): Record<string, unknown> {
  const entry = sender.openIdCards.find(e => e.openId === openId)
  if (!entry) {
    throw new Error(`no DM card pushed for ${openId}`)
  }
  return entry.card
}

function cardsForOpenId(
  sender: { openIdCards: Array<{ openId: string; card: Record<string, unknown> }> },
  openId: string,
): Record<string, unknown>[] {
  return sender.openIdCards
    .filter(e => e.openId === openId)
    .map(e => e.card)
}

function extractAction(card: Record<string, unknown>, action: string): PairingCardAction {
  const json = JSON.stringify(card)
  const parsed = JSON.parse(json) as {
    elements: Array<{ actions?: Array<{ value?: PairingCardAction }> }>
  }
  for (const element of parsed.elements) {
    for (const button of element.actions ?? []) {
      if (button.value?.action === action) {
        return button.value
      }
    }
  }
  throw new Error(`missing action ${action}`)
}
