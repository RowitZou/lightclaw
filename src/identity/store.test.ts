import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  setAdmin,
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

describe('identity permission ceiling defaults', () => {
  it('uses config.permissionCeiling when creating users and reading legacy records', async () => {
    writeConfig({ permissionCeiling: 'read' })
    assert.deepEqual(await createUser('alice'), { ok: true })
    assert.equal((await getIdentity('alice'))?.permissionCeiling, 'plan')

    assert.deepEqual(await createUser('bob'), { ok: true })
    const identitiesPath = path.join(home, 'identity', 'identities.json')
    const raw = JSON.parse(readFileSync(identitiesPath, 'utf8')) as Record<string, { permissionCeiling?: string }>
    delete raw.bob!.permissionCeiling
    writeFileSync(identitiesPath, JSON.stringify(raw), 'utf8')
    assert.equal(await getUserPermissionCeiling('bob'), 'plan')
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
