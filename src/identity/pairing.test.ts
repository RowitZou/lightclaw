import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { setLightclawHomeOverride } from '../paths.js'
import {
  generateOrReusePending,
  listPending,
  updatePendingApplicantText,
  updatePendingUserInfo,
} from './pairing.js'
import type { SenderKey } from './types.js'

let home: string

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'lightclaw-pairing-test-'))
  setLightclawHomeOverride(home)
})

afterEach(() => {
  setLightclawHomeOverride(undefined)
  rmSync(home, { recursive: true, force: true })
})

describe('updatePendingUserInfo', () => {
  it('adds display name, email, and tenant user id to existing pending entries', async () => {
    const { code } = await generateOrReusePending('feishu', 'ou_alice')
    await updatePendingUserInfo(code, {
      name: 'Alice',
      email: 'alice@example.com',
      userId: 'abcd1234',
    })

    const [entry] = await listPending()
    assert.equal(entry.code, code)
    assert.equal(entry.displayName, 'Alice')
    assert.equal(entry.email, 'alice@example.com')
    assert.equal(entry.userId, 'abcd1234')
  })

  it('no-ops on empty info or missing code', async () => {
    const { code } = await generateOrReusePending('feishu', 'ou_alice', 'Alice')
    await updatePendingUserInfo(code, {})
    await updatePendingUserInfo('NOPE0000', { name: 'Bob' })

    const [entry] = await listPending()
    assert.equal(entry.displayName, 'Alice')
    assert.equal(entry.email, undefined)
  })
})

describe('updatePendingApplicantText', () => {
  it('stashes the latest applicant text, chatId, and chatType on the matching entry', async () => {
    await generateOrReusePending('feishu', 'ou_alice', 'Alice')
    const senderKey: SenderKey = 'feishu:ou_alice'

    await updatePendingApplicantText(senderKey, '我想用 LightClaw 帮我看一下日志', 'oc_group_alice', 'group')

    const [entry] = await listPending()
    assert.equal(entry.lastApplicantText, '我想用 LightClaw 帮我看一下日志')
    assert.equal(entry.lastApplicantChatId, 'oc_group_alice')
    assert.equal(entry.lastApplicantChatType, 'group')
    assert.ok(entry.lastApplicantTextAt && entry.lastApplicantTextAt > 0)
  })

  it('records chatType=p2p for DM inbounds so replay routes back to DM', async () => {
    await generateOrReusePending('feishu', 'ou_alice', 'Alice')
    const senderKey: SenderKey = 'feishu:ou_alice'

    await updatePendingApplicantText(senderKey, 'hello', 'oc_dm_alice', 'p2p')

    const [entry] = await listPending()
    assert.equal(entry.lastApplicantChatType, 'p2p')
    assert.equal(entry.lastApplicantChatId, 'oc_dm_alice')
  })

  it('overwrites previous text when the applicant resends', async () => {
    await generateOrReusePending('feishu', 'ou_alice', 'Alice')
    const senderKey: SenderKey = 'feishu:ou_alice'

    await updatePendingApplicantText(senderKey, 'first try', 'oc_chat_a')
    await updatePendingApplicantText(senderKey, 'second try', 'oc_chat_b')

    const [entry] = await listPending()
    assert.equal(entry.lastApplicantText, 'second try')
    assert.equal(entry.lastApplicantChatId, 'oc_chat_b')
  })

  it('does NOT reset createdAt or ttlMs (TTL still measures from initial application)', async () => {
    await generateOrReusePending('feishu', 'ou_alice', 'Alice')
    const senderKey: SenderKey = 'feishu:ou_alice'
    const [before] = await listPending()
    const initialCreatedAt = before.createdAt
    const initialTtl = before.ttlMs

    await new Promise(resolve => setTimeout(resolve, 5))
    await updatePendingApplicantText(senderKey, 'late ping')

    const [after] = await listPending()
    assert.equal(after.createdAt, initialCreatedAt)
    assert.equal(after.ttlMs, initialTtl)
    assert.equal(after.lastApplicantText, 'late ping')
  })

  it('no-ops when both text and routing fields are absent or unknown sender', async () => {
    await generateOrReusePending('feishu', 'ou_alice', 'Alice')
    const senderKey: SenderKey = 'feishu:ou_alice'

    await updatePendingApplicantText(senderKey, '')
    await updatePendingApplicantText(senderKey, '   \n  ')
    await updatePendingApplicantText('feishu:ou_unknown' as SenderKey, 'noise')

    const [entry] = await listPending()
    assert.equal(entry.lastApplicantText, undefined)
    assert.equal(entry.lastApplicantChatId, undefined)
    assert.equal(entry.lastApplicantChatType, undefined)
  })

  it('stashes chatId / chatType even when applicant text is empty (so replay can route)', async () => {
    await generateOrReusePending('feishu', 'ou_alice', 'Alice')
    const senderKey: SenderKey = 'feishu:ou_alice'

    // User @-ed the bot in a group with no body — text is empty after
    // bot-mention strip, but we still must stash chatId / chatType so
    // post-approve can route the synthetic empty replay to that group.
    await updatePendingApplicantText(senderKey, '', 'oc_group_alice', 'group')

    const [entry] = await listPending()
    assert.equal(entry.lastApplicantText, undefined, 'no text body to stash')
    assert.equal(entry.lastApplicantChatId, 'oc_group_alice')
    assert.equal(entry.lastApplicantChatType, 'group')
    assert.equal(entry.lastApplicantTextAt, undefined, 'no textAt when text not set')
  })

  it('updates chatId independently of text on a later resend', async () => {
    await generateOrReusePending('feishu', 'ou_alice', 'Alice')
    const senderKey: SenderKey = 'feishu:ou_alice'

    // Initial empty @ in group
    await updatePendingApplicantText(senderKey, '', 'oc_group_alice', 'group')
    // Then user types a real follow-up in the same group
    await updatePendingApplicantText(senderKey, 'hello there', 'oc_group_alice', 'group')

    const [entry] = await listPending()
    assert.equal(entry.lastApplicantText, 'hello there')
    assert.equal(entry.lastApplicantChatId, 'oc_group_alice')
    assert.equal(entry.lastApplicantChatType, 'group')
  })
})
