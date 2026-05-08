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
  it('renders application cards and cancels without creating pending entries', async () => {
    const sender = new FakeSender()
    const coord = new PairingCardCoordinator(sender as unknown as FeishuSender)
    await coord.sendApplicationCard(fakeMessage('ou_user'), {
      applicantOpenId: 'ou_user',
      applicantName: 'Alice',
    })

    const action = extractAction(sender.replyCards[0], 'cancel')
    const response = await coord.handleCardAction(action)

    assert.equal(sender.replyCards.length, 1)
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

    const response = await coord.handleCardAction(extractAction(sender.replyCards[0], 'confirm'))
    const pending = await listPending()

    assert.equal(pending.length, 1)
    assert.equal(pending[0].displayName, 'Alice')
    assert.equal(pending[0].email, 'alice@example.com')
    assert.equal(pending[0].userId, 'abcd1234')
    assert.equal(sender.openIdCards.length, 1)
    assert.equal(sender.openIdCards[0].openId, 'ou_admin')
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
    const confirm = extractAction(sender.replyCards[0], 'confirm')
    await coord.handleCardAction(confirm)
    const reviewCard = sender.openIdCards[0].card
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
    await coord.handleCardAction(extractAction(sender.replyCards[0], 'confirm'))
    const reject = {
      ...extractAction(sender.openIdCards[0].card, 'reject'),
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
    await coord.handleCardAction(extractAction(sender.replyCards[0], 'confirm'))
    const approve = {
      ...extractAction(sender.openIdCards[0].card, 'approve'),
      operatorOpenId: 'ou_not_admin',
    }

    const response = await coord.handleCardAction(approve)

    assert.match(JSON.stringify(response), /仅管理员可审批/)
    assert.equal((await listPending()).length, 1)
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
