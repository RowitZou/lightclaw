import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { setLightclawHomeOverride } from '../paths.js'
import {
  addLink,
  createUser,
  getAdminFeishuOpenId,
  getIdentity,
  getUserPermissionCeiling,
  removeUser,
  setAdmin,
  setUserDataRoot,
  setUserPermissionCeiling,
} from './store.js'

let home: string

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'lightclaw-store-test-'))
  setLightclawHomeOverride(home)
  writeConfig({})
})

afterEach(() => {
  setLightclawHomeOverride(undefined)
  rmSync(home, { recursive: true, force: true })
})

describe('identity permission ceiling', () => {
  it('does not stamp a ceiling at creation; getUserPermissionCeiling follows live config', async () => {
    writeConfig({ permissionCeiling: 'read' })
    assert.deepEqual(await createUser('alice'), { ok: true })
    // createUser must not freeze the config default into the identity record,
    // otherwise a later config change can never reach the user.
    assert.equal((await getIdentity('alice'))?.permissionCeiling, undefined)
    assert.equal(await getUserPermissionCeiling('alice'), 'plan')

    writeConfig({ permissionCeiling: 'yolo' })
    assert.equal(await getUserPermissionCeiling('alice'), 'bypassPermissions')
  })

  it('an explicit /ceiling override persists and outranks the live config default', async () => {
    writeConfig({ permissionCeiling: 'yolo' })
    await createUser('bob')
    assert.equal((await setUserPermissionCeiling('bob', 'acceptEdits')).ok, true)
    assert.equal((await getIdentity('bob'))?.permissionCeiling, 'acceptEdits')
    writeConfig({ permissionCeiling: 'read' })
    assert.equal(await getUserPermissionCeiling('bob'), 'acceptEdits')
  })
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

describe('identity dataRoot', () => {
  it('purges the configured dataRoot when removing a user with --purge', async () => {
    await createUser('alice')
    const dataRoot = path.join(home, 'external-alice')
    mkdirSync(dataRoot, { recursive: true })
    await setUserDataRoot('alice', dataRoot)

    assert.equal((await removeUser('alice', { purge: true })).ok, true)
    assert.equal(existsSync(dataRoot), false)
  })
})

function writeConfig(overrides: object): void {
  writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({
      endpoints: { a: { apiKey: 'sk-a' } },
      models: {
        sonnet: { endpoint: 'a', schema: 'anthropic', upstreamModel: 'x' },
      },
      defaultModel: 'sonnet',
      ...overrides,
    }),
  )
}
