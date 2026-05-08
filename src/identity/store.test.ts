import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { setLightclawHomeOverride } from '../paths.js'
import {
  addLink,
  createUser,
  getAdminFeishuOpenId,
  setAdmin,
} from './store.js'

let home: string

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'lightclaw-store-test-'))
  setLightclawHomeOverride(home)
})

afterEach(() => {
  setLightclawHomeOverride(undefined)
  rmSync(home, { recursive: true, force: true })
})

describe('getAdminFeishuOpenId', () => {
  it('returns null when admin or feishu binding is absent', async () => {
    assert.equal(await getAdminFeishuOpenId(), null)
    await createUser('admin')
    await setAdmin('admin')
    assert.equal(await getAdminFeishuOpenId(), null)
  })

  it('returns the first feishu binding for the single admin', async () => {
    await createUser('admin')
    await setAdmin('admin')
    await addLink('admin', 'feishu:ou_admin')
    await addLink('admin', 'terminal:terminal-admin')

    assert.equal(await getAdminFeishuOpenId(), 'ou_admin')
  })
})
