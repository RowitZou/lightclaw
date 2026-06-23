import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { setLightclawHomeOverride } from '../paths.js'
import {
  createUser,
  getIdentity,
  listIdentities,
  setAdmin,
} from '../identity/store.js'
import { generateOrReusePending } from '../identity/pairing.js'
import { drainPendingPreheats } from '../identity/post-approve.js'

import { userApprove } from './builtin.js'

let home: string

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'lightclaw-approve-as-test-'))
  setLightclawHomeOverride(home)
  // Minimal config.json — getConfig() requires endpoints + models. Without
  // this, the rejectNonAdminInLocal gate (which calls getConfig) throws
  // before we ever exercise approve / addLink.
  writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({
      endpoints: { stub: { apiKey: 'sk-test', baseUrl: 'http://127.0.0.1:9' } },
      models: { 'stub-model': { endpoint: 'stub', schema: 'anthropic', upstreamModel: 'stub' } },
      defaultModel: 'stub-model',
    }),
  )
})

afterEach(async () => {
  // userApprove fires preheatAndWelcomeOnApproval as fire-and-forget; if
  // that promise outlives this afterEach, RuntimePool.acquire() inside
  // the preheat would read the *real* `~/.lightclaw/config.json` after
  // setLightclawHomeOverride(undefined) clears the override, then
  // mkdir the per-user workspace inside production `workspaceRoot`
  // (e.g. `claw_data/workspaces/otheruser_aabbccdd`). Drain first so
  // the mkdir lands inside the tmp home about to be removed.
  await drainPendingPreheats(5_000)
  setLightclawHomeOverride(undefined)
  rmSync(home, { recursive: true, force: true })
})

describe('/user approve --as <name>', () => {
  it('binds the IM sender into the existing admin instead of deriving a new user', async () => {
    await createUser('zouyicheng')
    await setAdmin('zouyicheng')

    const { code } = await generateOrReusePending(
      'feishu',
      'ou_admin_im',
      'Zou Yicheng',
      { userId: '62236ecd', email: 'zouyicheng@example.com' },
    )

    const out = await userApprove([code, '--as', 'zouyicheng'])
    assert.match(out, /zouyicheng/)

    const identities = await listIdentities()
    assert.deepEqual(Object.keys(identities).sort(), ['zouyicheng'])

    const admin = await getIdentity('zouyicheng')
    assert.deepEqual(admin?.channels.feishu, ['ou_admin_im'])
  })

  it('falls back to deriveCanonicalName when --as is omitted', async () => {
    // Switch to a non-local backend so the rejectNonAdminInLocal gate does
    // not block the auto-derived (non-admin) name. Default backend is
    // 'local'; a one-shot env override only for this test.
    process.env.LIGHTCLAW_RUNTIME_BACKEND = 'docker'
    try {
      await createUser('admin')
      await setAdmin('admin')

      const { code } = await generateOrReusePending(
        'feishu',
        'ou_other_im',
        'Other User',
        { userId: 'aabbccdd' },
      )

      const out = await userApprove([code])
      assert.match(out, /other.*aabbccdd|aabbccdd/i)

      const identities = await listIdentities()
      const names = Object.keys(identities).sort()
      assert.equal(names.length, 2, `expected admin + derived user, got ${names.join(', ')}`)
      assert.ok(names.includes('admin'))
      assert.ok(names.some(n => n.endsWith('_aabbccdd')))
    } finally {
      delete process.env.LIGHTCLAW_RUNTIME_BACKEND
    }
  })

  it('rejects an invalid --as name BEFORE consuming the pending code', async () => {
    await createUser('zouyicheng')
    await setAdmin('zouyicheng')

    const { code } = await generateOrReusePending('feishu', 'ou_pending', 'Foo')

    const out = await userApprove([code, '--as', '1bad-name'])
    assert.match(out, /身份名无效|Invalid identity name/i)

    const { listPending } = await import('../identity/pairing.js')
    const pending = await listPending()
    assert.equal(pending.length, 1, 'pending entry must NOT be consumed on invalid --as')
    assert.equal(pending[0].code, code)
  })

  it('rejects --as targeting a non-admin in local mode', async () => {
    await createUser('zouyicheng')
    await setAdmin('zouyicheng')

    const { code } = await generateOrReusePending('feishu', 'ou_pending', 'Foo')

    const out = await userApprove([code, '--as', 'someone_else'])
    // rejectNonAdminInLocal returns the localOnlyReject message.
    assert.match(out, /local|admin/i)

    const identities = await listIdentities()
    assert.deepEqual(Object.keys(identities).sort(), ['zouyicheng'])
  })

  it('returns usage on malformed args', async () => {
    assert.match(await userApprove([]), /\/admin pairing approve/)
    assert.match(await userApprove(['CODE', '--as']), /\/admin pairing approve/)
    assert.match(await userApprove(['CODE', '--bogus', 'foo']), /\/admin pairing approve/)
  })
})
