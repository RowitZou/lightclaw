import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { setLightclawHomeOverride } from '../paths.js'
import {
  addAdmin,
  addLink,
  createUser,
  getAdmin,
  getAdminFeishuOpenId,
  getAdminFeishuOpenIds,
  getIdentity,
  getUserPermissionCeiling,
  isAdmin,
  listAdmins,
  removeAdmin,
  setAdmin,
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

describe('multi-admin', () => {
  it('addAdmin lets multiple admins coexist; getAdmin returns the primary', async () => {
    await createUser('admin')
    await setAdmin('admin')
    await createUser('bob')
    await addAdmin('bob')

    assert.deepEqual(await listAdmins(), ['admin', 'bob'])
    // getAdmin must NOT throw with >1 admin (the old v1 cap is gone) and
    // returns the bootstrap/primary admin.
    assert.equal(await getAdmin(), 'admin')
    assert.equal(await isAdmin('admin'), true)
    assert.equal(await isAdmin('bob'), true)
    assert.equal(await isAdmin('carol'), false)
  })

  it('addAdmin is idempotent', async () => {
    await createUser('admin')
    await setAdmin('admin')
    await addAdmin('admin')
    assert.deepEqual(await listAdmins(), ['admin'])
  })

  it('removeAdmin removes a non-last admin but refuses the last one', async () => {
    await createUser('admin')
    await setAdmin('admin')
    await createUser('bob')
    await addAdmin('bob')

    assert.deepEqual(await removeAdmin('bob'), { ok: true })
    assert.deepEqual(await listAdmins(), ['admin'])
    assert.equal(await isAdmin('bob'), false)

    // The last admin cannot be removed — the deployment must keep at least one.
    assert.deepEqual(await removeAdmin('admin'), { ok: false, reason: 'last-admin' })
    assert.deepEqual(await listAdmins(), ['admin'])
  })

  it('removeAdmin reports not-admin for a user who is not an admin', async () => {
    await createUser('admin')
    await setAdmin('admin')
    assert.deepEqual(await removeAdmin('carol'), { ok: false, reason: 'not-admin' })
  })

  it('getAdminFeishuOpenIds fans out across every admin with a binding, skipping the unbound', async () => {
    await createUser('admin')
    await setAdmin('admin')
    await addLink('admin', 'feishu:ou_admin')
    await createUser('bob')
    await addAdmin('bob')
    await addLink('bob', 'feishu:ou_bob')
    await createUser('carol')
    await addAdmin('carol') // no feishu binding → skipped

    assert.deepEqual(await getAdminFeishuOpenIds(), ['ou_admin', 'ou_bob'])
    // The single-target accessor still returns the primary admin's binding.
    assert.equal(await getAdminFeishuOpenId(), 'ou_admin')
  })

  it('getAdminFeishuOpenIds is empty when no admin has a binding', async () => {
    await createUser('admin')
    await setAdmin('admin')
    assert.deepEqual(await getAdminFeishuOpenIds(), [])
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
