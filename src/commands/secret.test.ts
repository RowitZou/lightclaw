import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { userConfigPath } from '../identity/paths.js'
import { loadUserSecrets } from '../secrets/store.js'
import { resolveAuditDir } from '../config.js'
import { setLang } from '../i18n/index.js'
import { setLightclawHomeOverride } from '../paths.js'
import { createBuiltinReplRegistry } from './builtin.js'
import { runSecretCommand } from './secret.js'

// Usage fallbacks now return null (the /system key card renders them); coerce to
// string for the runner unit tests that assert on real results.
const runSecret = async (
  args: string,
  ctx: Parameters<typeof runSecretCommand>[1],
): Promise<string> => (await runSecretCommand(args, ctx)) ?? ''

describe('/secret command', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'lightclaw-secret-command-'))
    setLightclawHomeOverride(home)
    setLang('en')
  })

  afterEach(() => {
    setLang('cn')
    setLightclawHomeOverride(undefined)
    rmSync(home, { recursive: true, force: true })
  })

  it('sets, lists, and statuses a secret without echoing its value', async () => {
    const value = 'ghp_secret_value_with_$quotes" and spaces'
    const set = await runSecret(`set GH_TOKEN ${value}`, { userId: 'alice' })
    assert.match(set, /Secret GH_TOKEN saved/)
    assert.match(set, new RegExp(`${value.length} chars`))

    const listed = await runSecret('list', { userId: 'alice' })
    assert.match(listed, new RegExp(`GH_TOKEN \\(disabled, ${value.length} chars`))
    assert.equal(listed.includes(value), false)

    const status = await runSecret('status GH_TOKEN', { userId: 'alice' })
    assert.match(status, new RegExp(`GH_TOKEN: stored, disabled, ${value.length} chars`))
    assert.equal(status.includes(value), false)
    assert.equal(loadUserSecrets('alice').GH_TOKEN.value, value)
  })

  it('enables, disables, and retains the stored value', async () => {
    await runSecret('set GH_TOKEN secret', { userId: 'alice' })

    assert.match(
      await runSecret('enable GH_TOKEN', { userId: 'alice' }),
      /can use it/,
    )
    assert.match(await runSecret('status GH_TOKEN', { userId: 'alice' }), /stored, enabled,/)

    assert.match(
      await runSecret('disable GH_TOKEN', { userId: 'alice' }),
      /Stored value retained/,
    )
    assert.match(await runSecret('status GH_TOKEN', { userId: 'alice' }), /stored, disabled,/)
    assert.equal(loadUserSecrets('alice').GH_TOKEN.value, 'secret')
  })

  // A secret that backs a BYO endpoint is load-bearing: deleting it disables
  // that endpoint AND every model on it. Pre-fix `/secret rm` deleted with no
  // warning at all (the gate existed only on the `/system key rm` wrapper), so
  // one removal silently took four models offline in prod on 2026-08-13.
  // Fails on old code.
  it('rm of a referenced secret needs --y and names what goes offline', async () => {
    await runSecret('set BYO_KEY_1 sk-live', { userId: 'alice' })
    mkdirSync(path.dirname(userConfigPath('alice')), { recursive: true })
    writeFileSync(
      userConfigPath('alice'),
      JSON.stringify({
        endpoints: { gateway: { type: 'openai', apiKeyRef: 'BYO_KEY_1' } },
        models: {
          'gpt-gw': { endpoint: 'gateway', schema: 'openai', upstreamModel: 'gpt-5.5' },
          'gpt-gw-mini': { endpoint: 'gateway', schema: 'openai', upstreamModel: 'gpt-5.4-mini' },
        },
      }),
    )

    // No --y: preview names the endpoint + both models, and deletes nothing.
    const preview = await runSecret('rm BYO_KEY_1', { userId: 'alice' })
    assert.match(preview, /gateway/)
    assert.match(preview, /gpt-gw/)
    assert.match(preview, /gpt-gw-mini/)
    assert.match(preview, /--y/)
    assert.ok(loadUserSecrets('alice').BYO_KEY_1, 'the secret must survive an unconfirmed rm')

    // With --y: removed, and the result says what just went offline.
    const done = await runSecret('rm BYO_KEY_1 --y', { userId: 'alice' })
    assert.match(done, /removed/)
    assert.match(done, /gateway/)
    assert.match(done, /gpt-gw/)
    assert.equal(loadUserSecrets('alice').BYO_KEY_1, undefined)
  })

  it('rm of an unreferenced secret still deletes with no --y', async () => {
    await runSecret('set LONE sk-live', { userId: 'alice' })
    const out = await runSecret('rm LONE', { userId: 'alice' })
    assert.match(out, /removed/)
    assert.doesNotMatch(out, /--y/)
    assert.equal(loadUserSecrets('alice').LONE, undefined)
  })

  it('removes a secret and reports missing entries idempotently', async () => {
    await runSecret('set GH_TOKEN secret', { userId: 'alice' })
    assert.match(await runSecret('remove GH_TOKEN', { userId: 'alice' }), /removed/)
    assert.match(await runSecret('list', { userId: 'alice' }), /No secrets stored/)
    assert.match(await runSecret('remove GH_TOKEN', { userId: 'alice' }), /was not stored/)
  })

  it('round-trips values with shell-significant characters and long values', async () => {
    const special = 'value with spaces "$quote" $dollar `ticks`'
    await runSecret(`set API_TOKEN ${special}`, { userId: 'alice' })
    assert.equal(loadUserSecrets('alice').API_TOKEN.value, special)

    const long = 'x'.repeat(10_240)
    assert.match(await runSecret(`set LONG_TOKEN ${long}`, { userId: 'alice' }), /10240 chars/)
    assert.equal(loadUserSecrets('alice').LONG_TOKEN.value, long)
  })

  it('requires an active paired channel user', async () => {
    assert.match(
      await runSecret('list', {}),
      /requires a paired channel user/,
    )
  })

  it('reports invalid names and missing values with actionable output', async () => {
    assert.match(
      await runSecret('set bad-name value', { userId: 'alice' }),
      /secret name must match/,
    )
    assert.equal(
      await runSecretCommand('set GH_TOKEN', { userId: 'alice' }),
      null,
    )
    assert.match(
      await runSecret('enable MISSING', { userId: 'alice' }),
      /is not stored/,
    )
    assert.match(
      await runSecret('disable MISSING', { userId: 'alice' }),
      /was not stored/,
    )
  })

  it('supports list default, status all, help, and rm alias', async () => {
    assert.match(await runSecret('', { userId: 'alice' }), /No secrets stored/)
    assert.match(await runSecret('status', { userId: 'alice' }), /No secrets stored/)
    // `help` is a usage fallback → null (the /system key card renders the usage).
    assert.equal(await runSecretCommand('help', { userId: 'alice' }), null)

    await runSecret('set GH_TOKEN secret', { userId: 'alice' })
    assert.match(await runSecret('rm GH_TOKEN', { userId: 'alice' }), /removed/)
  })

  it('audits successful write operations without value, mask, length, or updatedAt', async () => {
    const value = 'chat-secret-value-that-must-not-be-audited'
    await runSecret(`set GH_TOKEN ${value}`, { userId: 'alice' })
    await runSecret(`set GH_TOKEN ${value}-replacement`, { userId: 'alice' })
    await runSecret('enable GH_TOKEN', { userId: 'alice' })
    await runSecret('disable GH_TOKEN', { userId: 'alice' })
    await runSecret('remove GH_TOKEN', { userId: 'alice' })

    const audit = readAuditLines()
    assert.deepEqual(audit.map(entry => entry.op), [
      'set',
      'set-replace',
      'enable',
      'disable',
      'remove',
    ])
    for (const entry of audit) {
      assert.equal(entry.user, 'alice')
      assert.equal(entry.name, 'GH_TOKEN')
      assert.equal(entry.source, 'chat')
      assert.equal('value' in entry, false)
      assert.equal('masked' in entry, false)
      assert.equal('length' in entry, false)
      assert.equal('updatedAt' in entry, false)
    }
    assertAuditFileDoesNotContain(value)
    assertAuditFileDoesNotContain(`${value}-replacement`)
    assert.equal(statSync(currentAuditPath()).mode & 0o777, 0o600)
  })

  it('appends concurrent audit rows as valid JSONL', async () => {
    const values = Array.from({ length: 10 }, (_, i) => [`K${i}`, `secret-value-${i}`] as const)
    await Promise.all(values.map(([name, value]) =>
      runSecretCommand(`set ${name} ${value}`, { userId: 'alice' }),
    ))

    const audit = readAuditLines()
    assert.equal(audit.length, 10)
    assert.deepEqual(audit.map(entry => entry.name).sort(), values.map(([name]) => name).sort())
    for (const [, value] of values) {
      assertAuditFileDoesNotContain(value)
    }
  })

  it('renders Chinese output under the cn locale (i18n migration guard)', async () => {
    setLang('cn')
    try {
      const saved = await runSecret('set GH_TOKEN val', { userId: 'alice' })
      assert.match(saved, /密钥 GH_TOKEN 已保存/)
      assert.equal(saved.includes('Secret GH_TOKEN saved'), false)
      assert.match(await runSecret('list', {}), /需要已配对的渠道用户/)
    } finally {
      setLang('en')
    }
  })

  it('retires the top-level /secret command (PR5.9 B6 — folded into /system key)', () => {
    // The /secret surface now lives under /system key; the old top-level name
    // is no longer registered in either surface. The underlying
    // runSecretCommand handler (exercised by the rest of this file) is still
    // reached via /system key.
    const channelRegistry = createBuiltinReplRegistry({ includeChannelOnly: true })
    const terminalRegistry = createBuiltinReplRegistry({ includeChannelOnly: false })
    assert.equal(channelRegistry.find('/secret'), undefined)
    assert.equal(terminalRegistry.find('/secret'), undefined)
  })
})

function currentAuditPath(): string {
  const day = new Date().toISOString().slice(0, 10)
  return path.join(resolveAuditDir(), 'secret-ops', `${day}.jsonl`)
}

function readAuditLines(): Array<Record<string, unknown>> {
  return readFileSync(currentAuditPath(), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>)
}

function assertAuditFileDoesNotContain(value: string): void {
  assert.equal(readFileSync(currentAuditPath(), 'utf8').includes(value), false)
}
