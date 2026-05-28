import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { loadUserSecrets } from '../secrets/store.js'
import { setLightclawHomeOverride } from '../paths.js'
import { createBuiltinReplRegistry } from './builtin.js'
import { runSecretCommand } from './secret.js'

describe('/secret command', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'lightclaw-secret-command-'))
    setLightclawHomeOverride(home)
  })

  afterEach(() => {
    setLightclawHomeOverride(undefined)
    rmSync(home, { recursive: true, force: true })
  })

  it('sets, lists, and statuses a secret without echoing its value', async () => {
    const value = 'ghp_secret_value_with_$quotes" and spaces'
    const set = await runSecretCommand(`set GH_TOKEN ${value}`, { userId: 'alice' })
    assert.match(set, /Secret GH_TOKEN saved/)
    assert.match(set, new RegExp(`length=${value.length}`))

    const listed = await runSecretCommand('list', { userId: 'alice' })
    assert.match(listed, new RegExp(`GH_TOKEN enabled=no length=${value.length}`))
    assert.equal(listed.includes(value), false)

    const status = await runSecretCommand('status GH_TOKEN', { userId: 'alice' })
    assert.match(status, new RegExp(`GH_TOKEN stored=yes enabled=no length=${value.length}`))
    assert.equal(status.includes(value), false)
    assert.equal(loadUserSecrets('alice').GH_TOKEN.value, value)
  })

  it('enables, disables, and retains the stored value', async () => {
    await runSecretCommand('set GH_TOKEN secret', { userId: 'alice' })

    assert.match(
      await runSecretCommand('enable GH_TOKEN', { userId: 'alice' }),
      /injected as \$GH_TOKEN/,
    )
    assert.match(await runSecretCommand('status GH_TOKEN', { userId: 'alice' }), /enabled=yes/)

    assert.match(
      await runSecretCommand('disable GH_TOKEN', { userId: 'alice' }),
      /Stored value retained/,
    )
    assert.match(await runSecretCommand('status GH_TOKEN', { userId: 'alice' }), /enabled=no/)
    assert.equal(loadUserSecrets('alice').GH_TOKEN.value, 'secret')
  })

  it('removes a secret and reports missing entries idempotently', async () => {
    await runSecretCommand('set GH_TOKEN secret', { userId: 'alice' })
    assert.match(await runSecretCommand('remove GH_TOKEN', { userId: 'alice' }), /removed/)
    assert.match(await runSecretCommand('list', { userId: 'alice' }), /No secrets stored/)
    assert.match(await runSecretCommand('remove GH_TOKEN', { userId: 'alice' }), /was not stored/)
  })

  it('round-trips values with shell-significant characters and long values', async () => {
    const special = 'value with spaces "$quote" $dollar `ticks`'
    await runSecretCommand(`set API_TOKEN ${special}`, { userId: 'alice' })
    assert.equal(loadUserSecrets('alice').API_TOKEN.value, special)

    const long = 'x'.repeat(10_240)
    assert.match(await runSecretCommand(`set LONG_TOKEN ${long}`, { userId: 'alice' }), /length=10240/)
    assert.equal(loadUserSecrets('alice').LONG_TOKEN.value, long)
  })

  it('requires an active paired channel user', async () => {
    assert.match(
      await runSecretCommand('list', {}),
      /requires a paired channel user/,
    )
  })

  it('reports invalid names and missing values with actionable output', async () => {
    assert.match(
      await runSecretCommand('set bad-name value', { userId: 'alice' }),
      /secret name must match/,
    )
    assert.match(
      await runSecretCommand('set GH_TOKEN', { userId: 'alice' }),
      /Usage:/,
    )
    assert.match(
      await runSecretCommand('enable MISSING', { userId: 'alice' }),
      /is not stored/,
    )
    assert.match(
      await runSecretCommand('disable MISSING', { userId: 'alice' }),
      /was not stored/,
    )
  })

  it('supports list default, status all, help, and rm alias', async () => {
    assert.match(await runSecretCommand('', { userId: 'alice' }), /No secrets stored/)
    assert.match(await runSecretCommand('status', { userId: 'alice' }), /No secrets stored/)
    assert.match(await runSecretCommand('help', { userId: 'alice' }), /\/secret set <NAME>/)

    await runSecretCommand('set GH_TOKEN secret', { userId: 'alice' })
    assert.match(await runSecretCommand('rm GH_TOKEN', { userId: 'alice' }), /removed/)
  })

  it('registers /secret as channel-only with agent metadata', () => {
    const channelRegistry = createBuiltinReplRegistry({ includeChannelOnly: true })
    const terminalRegistry = createBuiltinReplRegistry({ includeChannelOnly: false })

    const command = channelRegistry.find('/secret')
    assert.ok(command)
    assert.equal(command.channelOnly, true)
    assert.match(command.agentAdvisory ?? '', /API token/)
    assert.match(command.agentUsage ?? '', /\/secret enable <NAME>/)
    assert.equal(terminalRegistry.find('/secret'), undefined)
  })
})
