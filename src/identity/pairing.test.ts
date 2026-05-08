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
  it('stashes the latest applicant text and chatId on the matching entry', async () => {
    await generateOrReusePending('feishu', 'ou_alice', 'Alice')
    const senderKey: SenderKey = 'feishu:ou_alice'

    await updatePendingApplicantText(senderKey, '我想用 LightClaw 帮我看一下日志', 'oc_dm_alice')

    const [entry] = await listPending()
    assert.equal(entry.lastApplicantText, '我想用 LightClaw 帮我看一下日志')
    assert.equal(entry.lastApplicantChatId, 'oc_dm_alice')
    assert.ok(entry.lastApplicantTextAt && entry.lastApplicantTextAt > 0)
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

  it('no-ops on empty / whitespace text or unknown sender', async () => {
    await generateOrReusePending('feishu', 'ou_alice', 'Alice')
    const senderKey: SenderKey = 'feishu:ou_alice'

    await updatePendingApplicantText(senderKey, '')
    await updatePendingApplicantText(senderKey, '   \n  ')
    await updatePendingApplicantText('feishu:ou_unknown' as SenderKey, 'noise')

    const [entry] = await listPending()
    assert.equal(entry.lastApplicantText, undefined)
  })
})
