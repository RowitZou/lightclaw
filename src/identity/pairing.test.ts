import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { setLightclawHomeOverride } from '../paths.js'
import {
  generateOrReusePending,
  listPending,
  updatePendingUserInfo,
} from './pairing.js'

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
